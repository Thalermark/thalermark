import { generateObject } from 'ai';
import { z } from 'zod';
import { type LlmCredential, PRESETS, isCredentialUsable, resolveModel } from './provider.js';

// The save-time credential probe. A connection is not trusted until it has been
// authenticated — the mark, stamped. Saving runs this once and reports inline, so
// a bad key is discovered by the admin at config time rather than by a user at
// insight time as a bare 503.
//
// It is a `generateObject` call, not a `generateText` "respond OK", for two
// reasons. It exercises the exact code path every AI feature uses — structured
// extraction — so a "healthy" answer means something. And it DETECTS structured
// output support rather than asking the admin, who mostly cannot know whether
// their endpoint honours `response_format: json_schema`, and whose wrong guess
// fails silently: generateObject does not throw without it, it degrades to
// free-form JSON parsing and receipt fields go quietly wrong.

// Deliberately trivial: one boolean, a handful of tokens, cheap on any provider.
const PROBE_SCHEMA = z.object({ ok: z.boolean() });
const PROBE_PROMPT = 'Return {"ok": true}';

// Generous, and it has to be. A hosted API answers this in well under a second,
// but the local path — the one Ollama exists for — pays a cold model load on the
// first call: a 14B on CPU took ~37s to become ready in testing. A tighter bound
// fails exactly the self-hoster this feature is for. A dead endpoint still fails
// in milliseconds (connection refused), so this only lengthens the slow-but-alive
// case.
const PROBE_TIMEOUT_MS = 60_000;

export type ProbeResult =
  // `structured` is present ONLY when the probe measured it — i.e. for a custom
  // endpoint we had no prior knowledge of. For a preset it is absent, so the
  // stored connection keeps `structured` NULL ("trust the preset") rather than
  // freezing the preset's current value into the row.
  | { ok: true; latencyMs: number; structured?: boolean }
  | { ok: false; latencyMs: number; error: string };

// The provider's own error is what makes this useful ("invalid x-api-key",
// "model not found", "connection refused"), so it reaches the admin verbatim —
// minus the key, which some SDKs echo back inside the failing request, and minus
// any tail long enough to be a response body.
function sanitize(error: unknown, apiKey: string | undefined): string {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = apiKey?.trim() ? raw.split(apiKey.trim()).join('••••') : raw;
  return redacted.slice(0, 300);
}

// `aborted` distinguishes "the endpoint never answered" from "the endpoint said
// no". Only the latter is evidence about structured-output support.
export type ProbeAttempt = { ok: boolean; error?: unknown; aborted?: boolean };

// One round-trip. Injectable so probeCredential's precedence and detection logic
// can be tested without a live model.
export type ProbeRunner = (cred: LlmCredential) => Promise<ProbeAttempt>;

const liveRunner: ProbeRunner = async (cred) => {
  const model = resolveModel(cred, 'fast');
  if (!model) return { ok: false, error: new Error('no usable model for this credential') };
  const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  try {
    await generateObject({
      model,
      schema: PROBE_SCHEMA,
      prompt: PROBE_PROMPT,
      // A probe should fail fast and loudly; the SDK's default retries would
      // triple the wait on a wrong key and hide the first error.
      maxRetries: 0,
      abortSignal: signal,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error, aborted: signal.aborted };
  }
};

// Probe a credential and report health, latency, and — for endpoints we have no
// prior knowledge of — whether structured output actually works.
//
// Honest limit on the detection: this is a reliable NEGATIVE and an imperfect
// POSITIVE. A server that silently ignores `response_format` can still emit
// valid JSON because the prompt asked for it, so it records `true` without truly
// constraining. That endpoint would have behaved that way regardless; nothing is
// lost, only certainty is not gained.
//
// Scope: `fast` only. A custom endpoint can do structured text and have no vision
// model at all, which breaks receipt extraction alone. Probing vision costs an
// image and real tokens; the first real extraction call writes last_error instead.
export async function probeCredential(
  cred: LlmCredential,
  deps: { run?: ProbeRunner } = {},
): Promise<ProbeResult> {
  const run = deps.run ?? liveRunner;
  const started = Date.now();
  const elapsed = () => Date.now() - started;

  if (!isCredentialUsable(cred)) {
    return { ok: false, latencyMs: elapsed(), error: 'credential is incomplete' };
  }

  // Presets carry known-good answers; only an endpoint we have never met needs
  // probing twice. `custom` defaults to structured:false (fail safe), so the
  // first attempt deliberately overrides it to true to see whether that holds.
  const preset = PRESETS[(cred.provider ?? 'anthropic').trim().toLowerCase()];
  const detect = preset?.requiresBaseUrl === true && cred.structured === undefined;

  const first = await run(detect ? { ...cred, structured: true } : cred);
  if (first.ok) {
    // Report `structured` only when we measured it (detect). For a preset, omit
    // it so the stored row stays NULL and keeps tracking the preset in code.
    return detect
      ? { ok: true, latencyMs: elapsed(), structured: true }
      : { ok: true, latencyMs: elapsed() };
  }

  // The failure may be a rejected `response_format` rather than a bad key. One
  // retry without constrained decoding distinguishes them; if that fails too the
  // credential really is broken, and the first error is the honest one to report.
  //
  // But only retry on a genuine rejection. A timeout is not evidence about
  // structured support — it means the endpoint never answered — and retrying it
  // just doubles the wait before reporting the same abort. So skip the second
  // attempt when the first was aborted.
  if (detect && !first.aborted) {
    const second = await run({ ...cred, structured: false });
    if (second.ok) return { ok: true, latencyMs: elapsed(), structured: false };
  }

  return { ok: false, latencyMs: elapsed(), error: sanitize(first.error, cred.apiKey) };
}

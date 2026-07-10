import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

// The LLM credential a single AI call runs under. Resolved per account, per call,
// by an injected resolver (apps/api/src/lib/llm-credentials.ts) — the model is
// resolved from this bundle rather than bound at boot, which is what lets one
// process serve many accounts' keys.
//
// `provider` names a PRESET, not an adapter (see below). The per-role model
// overrides let a user point each task at a different model; this matters for
// Ollama, where vision and text are separate models (cloud Sonnet/Haiku are
// multimodal, so one model serves every role), and it is mandatory for `custom`,
// which ships no defaults. `structured` overrides the preset's declared support
// for constrained decoding; null means "trust the preset".
export interface LlmCredential {
  provider?: string;
  apiKey?: string;
  modelVision?: string;
  modelReasoning?: string;
  modelFast?: string;
  baseUrl?: string;
  structured?: boolean;
}

// Model roles, by task shape rather than vendor:
//   vision    — reads an image (receipt extraction)
//   reasoning — heavy text reasoning (cash-flow nudges)
//   fast      — cheap/quick text (expense categorization)
export type ModelRole = 'vision' | 'reasoning' | 'fast';

const ROLES = ['vision', 'reasoning', 'fast'] as const;

// The wire format, NOT a vendor. Internal and closed: Anthropic has its own
// protocol; OpenAI proper gets its own client because it sends OpenAI-specific
// params; everything else speaks OpenAI's shape at some base URL. Adding a
// vendor is a PRESETS entry (data). Adding an adapter is code, and the wire
// format is the slowest-moving layer in this stack — which is why this set is
// closed and why 'openai-compatible' is never a user-facing choice.
type Adapter = 'anthropic' | 'openai' | 'openai-wire';

export interface ProviderPreset {
  // Shown in the provider picker.
  label: string;
  adapter: Adapter;
  // anthropic/openai/custom need a key; Ollama does not (the AGPL-pure local path).
  needsKey: boolean;
  // Does this endpoint honour `response_format: json_schema` (constrained
  // decoding)? Without it the SDK won't send the schema and generateObject
  // degrades to flaky free-form JSON. Ollama's /v1 does honour it. `custom`
  // defaults to false (fail safe) and the save-time probe raises it.
  structured: boolean;
  // Default endpoint for openai-wire presets. A credential's baseUrl overrides it.
  baseUrl?: string;
  // `custom` has no default endpoint, so the credential must supply one.
  requiresBaseUrl?: boolean;
  // Absent for `custom`: the user supplies every role's model.
  models?: Record<ModelRole, string>;
}

// Providers as data. Default model ids live here rather than in a seeded table
// so they update with the image — a seed row goes stale forever, or needs a
// re-seed that clobbers whatever the user edited. Mirrors the email_templates
// pattern: defaults in code, a row only when someone customized.
//
// anthropic maps reasoning→Sonnet, fast→Haiku (the two-tier strategy in
// CLAUDE.md); vision reuses Sonnet since it's multimodal. ollama splits vision
// (llama3.2-vision) from text (llama3.2).
export const PRESETS: Record<string, ProviderPreset> = {
  anthropic: {
    label: 'Anthropic',
    adapter: 'anthropic',
    needsKey: true,
    structured: true,
    models: {
      vision: 'claude-sonnet-4-6',
      reasoning: 'claude-sonnet-4-6',
      fast: 'claude-haiku-4-5',
    },
  },
  openai: {
    label: 'OpenAI',
    adapter: 'openai',
    needsKey: true,
    structured: true,
    models: { vision: 'gpt-4o', reasoning: 'gpt-4o', fast: 'gpt-4o-mini' },
  },
  ollama: {
    label: 'Ollama (local)',
    adapter: 'openai-wire',
    needsKey: false,
    structured: true,
    baseUrl: 'http://localhost:11434',
    models: { vision: 'llama3.2-vision', reasoning: 'llama3.2', fast: 'llama3.2' },
  },
  // The escape hatch for any OpenAI-compatible endpoint we haven't blessed
  // (xAI, DeepSeek, Together, …). Declared, not smuggled: the user supplies the
  // endpoint and every model id, so no release is needed to reach a new vendor.
  custom: {
    label: 'Custom endpoint',
    adapter: 'openai-wire',
    needsKey: true,
    structured: false,
    requiresBaseUrl: true,
  },
};

function providerOf(cred: LlmCredential): string {
  // NB: an unset provider defaults to anthropic. A *stored* credential must
  // always write an explicit provider — this default exists for the env path.
  return (cred.provider ?? 'anthropic').trim().toLowerCase();
}

function presetFor(cred: LlmCredential): ProviderPreset | undefined {
  return PRESETS[providerOf(cred)];
}

function overrideFor(cred: LlmCredential, role: ModelRole): string | undefined {
  const raw =
    role === 'vision'
      ? cred.modelVision
      : role === 'reasoning'
        ? cred.modelReasoning
        : cred.modelFast;
  return raw?.trim() || undefined;
}

function modelFor(
  cred: LlmCredential,
  preset: ProviderPreset,
  role: ModelRole,
): string | undefined {
  return overrideFor(cred, role) ?? preset.models?.[role];
}

function baseUrlFor(cred: LlmCredential, preset: ProviderPreset): string | undefined {
  return cred.baseUrl?.trim() || preset.baseUrl;
}

// OpenAI-wire endpoints are addressed at /v1. `OLLAMA_BASE_URL` is documented
// without it, so append when absent rather than forcing every caller to know.
// A user pointing at an endpoint that already ends in /v1 gets it verbatim.
// Exported for its own test: the append-when-absent rule is the one behaviour
// the ollama → preset refactor must not regress. Not re-exported from index.
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

// Can this credential actually run a model? A preset must exist (an unknown
// provider is a typo), its key requirement must be met, its endpoint must be
// known, and *every role* must resolve to a model. That last clause is what
// keeps this honest for `custom`, which ships no defaults: a credential this
// vets must never yield a null model at a call site. The credential resolver
// (apps/api) uses it to decide "is AI available for this account?" without
// touching the SDK — a false answer 503s the route.
export function isCredentialUsable(cred: LlmCredential): boolean {
  const preset = presetFor(cred);
  if (!preset) return false;
  if (preset.needsKey && !cred.apiKey?.trim()) return false;
  if (preset.requiresBaseUrl && !baseUrlFor(cred, preset)) return false;
  return ROLES.every((role) => Boolean(modelFor(cred, preset, role)));
}

// Resolve a credential + role → a Vercel AI SDK model, or null when the
// credential can't run (see isCredentialUsable). Callers that pass a vetted
// credential (isCredentialUsable === true) can treat null as a misconfiguration.
export function resolveModel(cred: LlmCredential, role: ModelRole): LanguageModel | null {
  if (!isCredentialUsable(cred)) return null;
  const preset = presetFor(cred);
  // isCredentialUsable already rejected both cases; guard again for TS.
  if (!preset) return null;
  const model = modelFor(cred, preset, role);
  if (!model) return null;

  const key = cred.apiKey?.trim();
  if (preset.adapter === 'anthropic') return createAnthropic({ apiKey: key })(model);
  if (preset.adapter === 'openai') return createOpenAI({ apiKey: key })(model);

  const baseUrl = baseUrlFor(cred, preset);
  if (!baseUrl) return null;
  return createOpenAICompatible({
    name: providerOf(cred),
    baseURL: normalizeBaseUrl(baseUrl),
    // Ollama ignores the key, but the OpenAI-compatible client requires a
    // non-empty value.
    apiKey: key || 'unused',
    supportsStructuredOutputs: cred.structured ?? preset.structured,
  })(model);
}

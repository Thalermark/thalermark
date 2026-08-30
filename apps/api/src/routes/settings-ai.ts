import {
  PRESETS,
  type VisionProbeResult,
  probeCredential,
  probeVisionCredential,
} from '@thalermark/ai';
import { llmConnectionUpsertSchema } from '@thalermark/validation';
import { Hono } from 'hono';
import { validator } from 'hono/validator';
import type { AppDeps } from '../app.js';
import { checkBaseUrl } from '../lib/llm-endpoint.js';
import { requireCapability } from '../middleware/authz.js';
import type { RlsVariables } from '../middleware/rls-context.js';

// Settings → AI — the in-app surface that replaced the LLM_* env. Owner/admin
// only (settings:manage), and a deferred-tx route (see rls-context): /verify runs
// the model probe for up to 60s and must not pin a wrapping connection. The store
// (deps.llmConnections) does all the DB work in its own short txs; audit rows are
// written via runInTx.
//
// The key never crosses back to the client: GET returns a masked hint, PUT never
// echoes it, and the audit before/after record only provider + hasKey.

// The preset registry, shaped for the picker. Model defaults ride along so the
// Advanced fields can prefill instead of showing blank boxes.
function presetList() {
  return Object.entries(PRESETS).map(([id, preset]) => ({
    id,
    label: preset.label,
    needsKey: preset.needsKey,
    requiresBaseUrl: preset.requiresBaseUrl ?? false,
    baseUrl: preset.baseUrl ?? null,
    models: preset.models ?? null,
  }));
}

export function settingsAiRoutes(deps: AppDeps) {
  const store = deps.llmConnections;
  const allowPrivate = deps.aiAllowPrivateEndpoints === true;
  const allowedEndpoints = deps.aiAllowedEndpoints ?? [];

  return new Hono<{ Variables: RlsVariables }>()
    .get('/api/settings/ai', requireCapability('settings:manage'), async (c) => {
      if (!store) return c.json({ error: 'ai_not_available' }, 503);
      const connection = await store.getDisplay(c.get('accountId'));
      // allowPrivate + allowedEndpoints are operator config, surfaced READ-ONLY so
      // the UI can turn a private-address rejection into "here's what your server
      // permits" instead of a dead end. They are never editable from the client —
      // widening what the server may reach is an operator (env) decision.
      return c.json({ connection, presets: presetList(), allowPrivate, allowedEndpoints });
    })

    .put(
      '/api/settings/ai',
      requireCapability('settings:manage'),
      validator('json', (value, c) => {
        const parsed = llmConnectionUpsertSchema.safeParse(value);
        if (!parsed.success) {
          return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
        }
        return parsed.data;
      }),
      async (c) => {
        // Kept in the handler rather than an earlier middleware: it also narrows
        // `store` for the writes below. The only cost is that a malformed body on
        // an AI-less deployment answers 400 before this 503, which nothing reads.
        if (!store) return c.json({ error: 'ai_not_available' }, 503);
        const input = c.req.valid('json');
        const provider = input.provider.trim().toLowerCase();
        const preset = PRESETS[provider];
        if (!preset) return c.json({ error: 'unknown_provider' }, 400);

        // SSRF guard, on the write path — this is where a user-supplied base URL
        // first enters, and it must be vetted before the probe (or any AI call)
        // requests it. Re-run on every write so a repoint is re-vetted, not trusted
        // from a stale save.
        const baseUrl = input.baseUrl?.trim() || null;
        if (baseUrl) {
          const check = await checkBaseUrl(baseUrl, { allowPrivate, allowedEndpoints });
          if (!check.ok) return c.json({ error: 'endpoint_rejected', reason: check.reason }, 400);
        } else if (preset.requiresBaseUrl) {
          return c.json({ error: 'base_url_required' }, 400);
        }

        const accountId = c.get('accountId');
        const before = await store.getDisplay(accountId);
        await store.upsert(
          accountId,
          {
            provider,
            baseUrl,
            apiKey: input.apiKey, // tri-state (undefined keep / ''|null clear / string set)
            modelVision: input.modelVision ?? null,
            modelReasoning: input.modelReasoning ?? null,
            modelFast: input.modelFast ?? null,
            timeoutSeconds: input.timeoutSeconds ?? null,
          },
          c.get('userId'),
        );
        const after = await store.getDisplay(accountId);

        await c.var.runInTx(async (_tx, audit) => {
          await audit({
            entityType: 'llm_connection',
            entityId: accountId,
            action: before ? 'update' : 'create',
            before: before ? { provider: before.provider, hasKey: before.hasKey } : null,
            after: after ? { provider: after.provider, hasKey: after.hasKey } : null,
          });
        });

        // Saved, not verified: the health gate keeps AI off until /verify passes.
        return c.json({ connection: after });
      },
    )

    .delete('/api/settings/ai', requireCapability('settings:manage'), async (c) => {
      if (!store) return c.json({ error: 'ai_not_available' }, 503);
      const accountId = c.get('accountId');
      const before = await store.getDisplay(accountId);
      if (!before) return c.json({ ok: true }); // idempotent — nothing to remove
      await store.remove(accountId);
      await c.var.runInTx(async (_tx, audit) => {
        await audit({
          entityType: 'llm_connection',
          entityId: accountId,
          action: 'delete',
          before: { provider: before.provider, hasKey: before.hasKey },
          after: null,
        });
      });
      return c.json({ ok: true });
    })

    .post('/api/settings/ai/verify', requireCapability('settings:manage'), async (c) => {
      if (!store) return c.json({ error: 'ai_not_available' }, 503);
      const accountId = c.get('accountId');
      // getProbeCredential is the ungated read: the row is unverified by
      // definition here, so getUsable would refuse it.
      const credential = await store.getProbeCredential(accountId);
      if (!credential) return c.json({ error: 'no_connection' }, 400);

      const probe = deps.llmProbe ?? probeCredential;
      const result = await probe(credential);
      await store.recordProbeResult(accountId, result);

      // Second stage (TMC-296): the vision role, probed only after a fast-probe
      // success — a dead endpoint or bad key has already told the whole story.
      // A vision failure is recorded AFTER the success write, so the chip goes
      // red carrying the vision error while last_ok_at stays fresh and the
      // text-role features (categorize, nudges) keep working. Before this, a
      // vision model that could not load verified green and broke receipt
      // extraction alone, with the reason visible nowhere.
      let vision: VisionProbeResult | null = null;
      if (result.ok) {
        const visionProbe = deps.llmVisionProbe ?? probeVisionCredential;
        // Thread the structured answer the fast probe just measured (custom
        // endpoints only) so the vision call runs in the mode that worked.
        vision = await visionProbe(
          result.structured !== undefined
            ? { ...credential, structured: result.structured }
            : credential,
        );
        if (!vision.ok) {
          await store.recordProbeResult(accountId, {
            ok: false,
            latencyMs: vision.latencyMs,
            error: `Receipt reading (vision model): ${vision.error}`,
          });
        }
      }

      const connection = await store.getDisplay(accountId);
      // result/vision carry the provider's own error on failure — surfaced to
      // the admin at config time, key already redacted by the probes.
      return c.json({ result, vision, connection });
    });
}

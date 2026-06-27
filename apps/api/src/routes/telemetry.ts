import { emit } from '@thalermark/telemetry';
import { telemetryIngestSchema } from '@thalermark/validation';
import { Hono } from 'hono';
import type { RlsVariables } from '../middleware/rls-context.js';

// telemetry — the client-ingest pipeline (TELEMETRY.md). Browser/app-only
// events (today just report_viewed) POST here in batches; each is staged via the
// same opt-in-gated emit() the server-side events use, so an opted-out account
// stages nothing even though the client posts best-effort. No capability gate —
// it's the member's own activity — but the standard tenant context (x-account-id
// → tx) applies. The schema rejects any unwired event shape. A deps-free sub-app
// (cf. items/tax-policies); mounted on createApp via .route() so its schema
// rides on its own TelemetryAppType instead of bloating AppType past TS7056.
export function telemetryRoutes() {
  return new Hono<{ Variables: RlsVariables }>().post('/api/telemetry/ingest', async (c) => {
    const parsed = telemetryIngestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
    }
    const tx = c.get('tx');
    for (const event of parsed.data.events) {
      await emit(tx, event);
    }
    return c.json({ accepted: parsed.data.events.length });
  });
}

export type TelemetryAppType = ReturnType<typeof telemetryRoutes>;

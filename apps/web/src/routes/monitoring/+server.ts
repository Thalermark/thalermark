import { env } from '$env/dynamic/public';
import { tunnelEnvelope } from '$lib/monitoring-tunnel';
import type { RequestHandler } from './$types';

// GlitchTip/Sentry tunnel endpoint (TMC-131). The browser SDK (hooks.client.ts
// `tunnel: '/monitoring'`) POSTs its error envelopes here — same-origin, so ad /
// privacy blockers that match the well-known `…/envelope/` tracker URL don't drop
// them. Forwarding + the open-relay guard live in tunnelEnvelope so they're
// unit-tested; this handler only supplies the configured DSN + fetch.
export const POST: RequestHandler = async ({ request }) => {
  const body = await request.arrayBuffer();
  return tunnelEnvelope(env.PUBLIC_ERROR_TRACKING_DSN, body, fetch);
};

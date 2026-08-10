import { apiBaseUrl, apiFetch, serverApiHeaders } from '$lib/api.server';
import type { RequestHandler } from './$types';

// Same-origin proxy for the client telemetry emitter ($lib/telemetry). The
// browser can't stamp x-account-id, so it posts here and we forward the raw
// batch to the API with the session cookie + active-account header (like the
// load-more / search proxies). The API validates and opt-in-gates; this is a
// dumb pass-through. Best-effort, so a forwarding failure is swallowed.
export const POST: RequestHandler = async (event) => {
  const body = await event.request.text();
  try {
    const res = await apiFetch(
      `${apiBaseUrl()}/api/telemetry/ingest`,
      {
        method: 'POST',
        headers: { ...serverApiHeaders(event), 'content-type': 'application/json' },
        body,
      },
      event.fetch,
    );
    return new Response(await res.text(), {
      status: res.status,
      headers: { 'content-type': 'application/json' },
    });
  } catch {
    return new Response(null, { status: 204 });
  }
};

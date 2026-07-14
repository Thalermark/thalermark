// Core forwarding logic for the GlitchTip/Sentry tunnel (routes/monitoring,
// TMC-131), extracted from the +server handler so the parsing + open-relay guard
// are unit-testable without SvelteKit's $env / global fetch. The handler just
// wires those in.
//
// The browser SDK POSTs its error envelopes to the same-origin /monitoring path
// (hooks.client.ts `tunnel`) instead of straight to the GlitchTip host, because
// ad / privacy blockers match the well-known `…/envelope/` tracker URL and drop
// a real share of client error reports. We forward the envelope server-side to
// the operator's configured DSN host — and ONLY there.

export type FetchLike = typeof fetch;

// Forward one Sentry/GlitchTip envelope to the configured DSN's ingest endpoint.
// `dsnRaw` is PUBLIC_ERROR_TRACKING_DSN; `body` is the raw envelope bytes.
export async function tunnelEnvelope(
  dsnRaw: string | undefined,
  body: ArrayBuffer,
  fetchImpl: FetchLike,
): Promise<Response> {
  // Tracking off (default self-host) → nothing to forward. The client SDK is
  // inert too, so this shouldn't be hit; answer inertly if it is.
  if (!dsnRaw) return new Response(null, { status: 204 });

  let configured: URL;
  try {
    configured = new URL(dsnRaw);
  } catch {
    return new Response(null, { status: 204 });
  }
  const allowedProject = configured.pathname.replace(/^\//, '');

  // The envelope's first line is a JSON header carrying the originating DSN.
  const text = new TextDecoder().decode(body);
  const nl = text.indexOf('\n');
  if (nl === -1) return new Response('invalid envelope', { status: 400 });

  let head: { dsn?: string };
  try {
    head = JSON.parse(text.slice(0, nl));
  } catch {
    return new Response('invalid envelope', { status: 400 });
  }
  if (!head.dsn) return new Response('missing dsn', { status: 400 });

  let envDsn: URL;
  try {
    envDsn = new URL(head.dsn);
  } catch {
    return new Response('invalid dsn', { status: 400 });
  }
  const project = envDsn.pathname.replace(/^\//, '');
  // Open-relay guard: forward only to OUR configured host + project; reject an
  // envelope whose embedded DSN points anywhere else.
  if (envDsn.host !== configured.host || project !== allowedProject) {
    return new Response('forbidden', { status: 403 });
  }

  const upstream = `${configured.protocol}//${configured.host}/api/${allowedProject}/envelope/`;
  try {
    const res = await fetchImpl(upstream, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/x-sentry-envelope' },
    });
    return new Response(null, { status: res.ok ? 201 : 502 });
  } catch {
    return new Response(null, { status: 502 });
  }
}

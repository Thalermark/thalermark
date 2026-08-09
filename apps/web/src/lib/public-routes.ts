// Which URLs render without a session.
//
// These three tables are the whole authorization boundary of the public
// surface, and getting one wrong fails silently in the worst possible
// direction: /pay/ was missing for the entire life of the payment feature, so
// every customer who clicked Pay on an invoice was redirected to /sign-in and
// could not pay at all (TMC-209). Nobody noticed because a signed-in session
// satisfies the guard, so it worked in every hand test.
//
// They live here rather than inside hooks.server.ts so they can be asserted in
// a unit test — importing the hook drags in its module-scope Sentry init and
// env plumbing, which is why the list went untested in the first place.

// Signed-out-only pages. Public, but a signed-in visitor is sent home instead
// of being shown a sign-in form.
export const REDIRECT_IF_AUTHED = new Set(['/sign-in', '/sign-up']);

// Exact-match public paths. /monitoring is the client error-tracking tunnel
// (routes/monitoring): the browser SDK POSTs error envelopes there. It must
// accept them without a session — client errors happen on public pages and for
// logged-out visitors too — so it can't be behind the /sign-in redirect.
export const PUBLIC_PATHS = new Set([...REDIRECT_IF_AUTHED, '/accept-invite', '/monitoring']);

// Parameterized public paths, prefix-matched so each new public route is
// visible at this top-level config rather than buried in per-route guards.
//
// /i/ and /e/ — the public invoice and estimate views. The recipient of an
// invoice email has no account here.
// /legal/ — Terms + Privacy, linked from the sign-up clickwrap before the
// visitor has an account.
// /pay/ — the card-payment page /i/[token] links to, authorized by the same
// public token. The person clicking Pay is by definition a stranger.
export const PUBLIC_PREFIXES = ['/i/', '/e/', '/legal/', '/pay/'];

export function isPublicPrefix(path: string): boolean {
  return PUBLIC_PREFIXES.some((p) => path.startsWith(p));
}

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
//
// /forgot-password and /reset-password are here for the reason that should have
// been obvious and wasn't: the entire audience for password recovery is people
// who cannot sign in. Both were missing, so both 303'd to /sign-in — the form
// was unreachable, AND the emailed reset link bounced, on every install
// including SaaS. Same shape as the /pay/ omission in TMC-209: a route that
// works perfectly while you happen to hold a session, so it passes every hand
// test by the person who built it.
export const PUBLIC_PATHS = new Set([
  ...REDIRECT_IF_AUTHED,
  '/accept-invite',
  '/monitoring',
  '/forgot-password',
  '/reset-password',
]);

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

// Routes outside the (app) group that require a session ON PURPOSE.
//
// Its only job is to be a place where "this one is private" has to be written
// down. The lists above can only be wrong by omission, and an omission is
// invisible: the guard's default is private, and a developer is always signed
// in, so a route that should be public looks fine to the person who added it.
// That is not hypothetical — /pay/ (TMC-209), /forgot-password and
// /reset-password (TMC-239) all shipped that way, in three separate features.
//
// The test beside this file walks the routes directory and fails on anything
// that appears in neither this list nor the public ones, so the next such route
// is a red PR rather than a bug report from someone who cannot pay or cannot
// get back into their account.
//
// Being in this list is a claim, not a formality: it says someone looked at the
// route and decided a stranger has no business reaching it.
export const PRIVATE_ON_PURPOSE = new Set([
  // First-run wizard. Nothing to show a visitor who has no account yet, and it
  // writes to one — sign-up is the way in.
  '/welcome',
]);

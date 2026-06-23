import { dev } from '$app/environment';
import { env as privateEnv } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import * as Sentry from '@sentry/sveltekit';
import { type Handle, error, redirect } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import type { Session } from './app.d.ts';

// SSR-side error tracking. Inert unless PUBLIC_ERROR_TRACKING_DSN is set — same
// opt-in posture as the api (apps/api/src/lib/error-tracking.ts). Shares the DSN
// with the browser init in hooks.client.ts (it's a write-only public key).
// GlitchTip is the chosen backend; the SDK is backend-agnostic via the DSN.
const errorTrackingDsn = publicEnv.PUBLIC_ERROR_TRACKING_DSN;
if (errorTrackingDsn) {
  Sentry.init({
    dsn: errorTrackingDsn,
    environment: dev ? 'development' : 'production',
    release: publicEnv.PUBLIC_RELEASE || undefined,
    // No performance tracing yet — mirror the api (tracesSampleRate: 0).
    tracesSampleRate: 0,
  });
}

// SSR fetches need an absolute URL. Behind Caddy the browser uses relative
// /api/* paths (PUBLIC_API_URL=""), so the server resolves a separate
// INTERNAL_API_URL pointed at the api container's compose hostname. `||` not
// `??` so an explicit empty PUBLIC_API_URL falls through to the dev fallback.
const apiUrl = privateEnv.INTERNAL_API_URL || publicEnv.PUBLIC_API_URL || 'http://localhost:3000';

const REDIRECT_IF_AUTHED = new Set(['/sign-in', '/sign-up']);
const PUBLIC_PATHS = new Set([...REDIRECT_IF_AUTHED, '/accept-invite']);
// Parameterized public paths. The public invoice view at /i/[token] needs
// to render without a session — the recipient of an invoice email has no
// account here. Prefix-matched so each new public route is visible at this
// top-level config rather than buried in per-route +layout guards.
const PUBLIC_PREFIXES = ['/i/', '/e/'];
const SELECT_COMPANY_PATH = '/select-company';
const ACTIVE_COOKIE = 'active_account_id';

function isPublicPrefix(path: string): boolean {
  return PUBLIC_PREFIXES.some((p) => path.startsWith(p));
}

async function loadSession(cookieHeader: string | null): Promise<Session | null> {
  if (!cookieHeader) return null;
  // Distinguish "no session" from "server fault". A 401 means the cookie is
  // missing/expired → genuinely unauthenticated, return null and let the gate
  // route to /sign-in. Any other failure (api unreachable, or a 5xx — e.g. the
  // DB is a migration behind so /api/me errors) is a SERVER problem: surface it
  // instead of masquerading as logged-out, which otherwise bounces a validly
  // signed-in user into an endless /sign-in loop with no error shown.
  let res: Response;
  try {
    res = await fetch(`${apiUrl}/api/me`, { headers: { cookie: cookieHeader } });
  } catch {
    throw error(503, 'Cannot reach the server right now. Please try again shortly.');
  }
  if (res.status === 401) return null;
  if (!res.ok) {
    throw error(503, 'Something went wrong loading your session. Please try again shortly.');
  }
  return (await res.json()) as Session;
}

const appHandle: Handle = async ({ event, resolve }) => {
  event.locals.session = await loadSession(event.request.headers.get('cookie'));

  const path = event.url.pathname;

  if (PUBLIC_PATHS.has(path)) {
    if (REDIRECT_IF_AUTHED.has(path) && event.locals.session) {
      throw redirect(303, '/');
    }
    return resolve(event);
  }

  if (isPublicPrefix(path)) {
    return resolve(event);
  }

  const session = event.locals.session;
  if (!session) throw redirect(303, '/sign-in');

  const memberships = session.memberships;
  const cookieValue = event.cookies.get(ACTIVE_COOKIE);

  if (memberships.length === 0) {
    if (path !== SELECT_COMPANY_PATH) throw redirect(303, SELECT_COMPANY_PATH);
    return resolve(event);
  }

  if (memberships.length === 1) {
    const only = memberships[0];
    if (only && cookieValue !== only.accountId) {
      event.cookies.set(ACTIVE_COOKIE, only.accountId, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 60 * 60 * 24 * 365,
      });
    }
    if (only) {
      event.locals.activeAccountId = only.accountId;
      event.locals.role = only.role;
    }
    return resolve(event);
  }

  const active = memberships.find((m) => m.accountId === cookieValue);
  if (cookieValue && active) {
    event.locals.activeAccountId = active.accountId;
    event.locals.role = active.role;
    return resolve(event);
  }

  if (path !== SELECT_COMPANY_PATH) throw redirect(303, SELECT_COMPANY_PATH);
  return resolve(event);
};

// SvelteKit's adapter-node serves pages as bare `text/html` with no charset.
// Behind a proxy a browser can then fall back to a legacy encoding and render
// UTF-8 text (em dashes, curly quotes) as mojibake — even though app.html
// declares <meta charset="utf-8">, since a transport-level charset is read
// before the meta prescan and isn't always honored otherwise. Stamp it
// explicitly on every HTML response.
const charsetHandle: Handle = async ({ event, resolve }) => {
  const response = await resolve(event);
  const contentType = response.headers.get('content-type');
  if (contentType?.startsWith('text/html') && !/;\s*charset=/i.test(contentType)) {
    response.headers.set('content-type', 'text/html; charset=utf-8');
  }
  return response;
};

// Run Sentry's request handler ahead of the app's only when tracking is on, so
// SSR errors carry request context. charsetHandle always runs so the charset is
// stamped regardless of the tracking config.
export const handle: Handle = errorTrackingDsn
  ? sequence(Sentry.sentryHandle(), charsetHandle, appHandle)
  : sequence(charsetHandle, appHandle);

// Reports unexpected SSR errors to Sentry (a no-op while uninitialised).
export const handleError = Sentry.handleErrorWithSentry();

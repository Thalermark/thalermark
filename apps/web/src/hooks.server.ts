import { env as privateEnv } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import { type Handle, redirect } from '@sveltejs/kit';
import type { Session } from './app.d.ts';

// SSR fetches need an absolute URL. Behind Caddy the browser uses relative
// /api/* paths (PUBLIC_API_URL=""), so the server resolves a separate
// INTERNAL_API_URL pointed at the api container's compose hostname. `||` not
// `??` so an explicit empty PUBLIC_API_URL falls through to the dev fallback.
const apiUrl = privateEnv.INTERNAL_API_URL || publicEnv.PUBLIC_API_URL || 'http://localhost:3000';

const REDIRECT_IF_AUTHED = new Set(['/sign-in', '/sign-up']);
const PUBLIC_PATHS = new Set([...REDIRECT_IF_AUTHED, '/accept-invite']);
const SELECT_COMPANY_PATH = '/select-company';
const ACTIVE_COOKIE = 'active_company_id';
// Plan-locked cookie name. The value currently holds an account UUID because
// memberships are at the account level in MVP; a future companies-level
// picker can promote this without renaming the cookie.

async function loadSession(cookieHeader: string | null): Promise<Session | null> {
  if (!cookieHeader) return null;
  try {
    const res = await fetch(`${apiUrl}/api/me`, { headers: { cookie: cookieHeader } });
    if (!res.ok) return null;
    return (await res.json()) as Session;
  } catch {
    return null;
  }
}

export const handle: Handle = async ({ event, resolve }) => {
  event.locals.session = await loadSession(event.request.headers.get('cookie'));

  const path = event.url.pathname;

  if (PUBLIC_PATHS.has(path)) {
    if (REDIRECT_IF_AUTHED.has(path) && event.locals.session) {
      throw redirect(303, '/');
    }
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
    if (only) event.locals.activeCompanyId = only.accountId;
    return resolve(event);
  }

  if (cookieValue && memberships.some((m) => m.accountId === cookieValue)) {
    event.locals.activeCompanyId = cookieValue;
    return resolve(event);
  }

  if (path !== SELECT_COMPANY_PATH) throw redirect(303, SELECT_COMPANY_PATH);
  return resolve(event);
};

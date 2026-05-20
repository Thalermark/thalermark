import { env } from '$env/dynamic/public';
import { type Handle, redirect } from '@sveltejs/kit';
import type { Session } from './app.d.ts';

const apiUrl = env.PUBLIC_API_URL ?? 'http://localhost:3000';

const REDIRECT_IF_AUTHED = new Set(['/sign-in', '/sign-up']);
const PUBLIC_PATHS = new Set([...REDIRECT_IF_AUTHED, '/accept-invite']);

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
  } else if (!event.locals.session) {
    throw redirect(303, '/sign-in');
  }

  return resolve(event);
};

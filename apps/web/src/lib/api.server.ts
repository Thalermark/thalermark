import { env as privateEnv } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import type { RequestEvent } from '@sveltejs/kit';
import type { AppType } from '@thalermark/api-contract';
import { hc } from 'hono/client';

// SSR fetches need an absolute URL. Mirrors hooks.server.ts — `||` not `??` so
// an explicit empty PUBLIC_API_URL (the self-host default, where the browser
// uses relative /api/*) falls through to the internal compose hostname.
const baseUrl = () =>
  privateEnv.INTERNAL_API_URL || publicEnv.PUBLIC_API_URL || 'http://localhost:3000';

// Server-side hc client. Forwards the BA session cookie from the incoming
// request and stamps x-account-id from locals.activeCompanyId (set by
// hooks.server.ts). The browser client at $lib/api.ts is the cookie-jar
// equivalent for client-side calls.
export function serverApiClient(event: RequestEvent) {
  const headers: Record<string, string> = {};
  const cookie = event.request.headers.get('cookie');
  if (cookie) headers.cookie = cookie;
  if (event.locals.activeCompanyId) headers['x-account-id'] = event.locals.activeCompanyId;
  return hc<AppType>(baseUrl(), { headers });
}

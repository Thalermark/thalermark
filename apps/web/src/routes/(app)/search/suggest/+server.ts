import { cookieCompanyId } from '$lib/active-company';
import { serverApiClient } from '$lib/api.server';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';

// Same-origin browser proxy for the header search box (TMC-198). Mirrors
// contacts/search and items/search: Caddy routes /api/* to the Hono api, auth is
// already gated by hooks.server.ts, and serverApiClient forwards the session
// cookie + x-account-id so the underlying GET /api/search stays tenant-scoped.
//
// It also exists because the browser client at $lib/api.ts is hc<AppType> only,
// and AppType is now just the middleware shell — it cannot reach a sub-app route
// typed, so a client-side call has to come through a +server.ts.
//
// Lives at /search/suggest rather than /search: SvelteKit will let a +server.ts
// and a +page.svelte share a directory and disambiguate on Accept, but that is a
// trap for whoever touches this next. Separate paths, no ambiguity.
export const GET: RequestHandler = async (event) => {
  const q = event.url.searchParams.get('q')?.trim();
  if (!q) return json({ results: [] });

  const client = serverApiClient(event);
  // Scope to the active company so the dropdown never offers another business's
  // records. The cookie is kept healed by the (app) layout load.
  const companyId = cookieCompanyId(event.cookies);
  const query: Record<string, string> = { q, group: '1', limit: '8' };
  if (companyId) query.companyId = companyId;

  const res = await client.api.search.$get({ query });
  // Degrade to empty rather than an error status: a type-ahead that renders a
  // failure state on a transient blip is worse than one that shows nothing. The
  // full /search page surfaces real failures.
  if (!res.ok) return json({ results: [] });
  const body = await res.json();

  return json({ results: body.results });
};

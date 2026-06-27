import { cookieCompanyId } from '$lib/active-company';
import { serverApiClient } from '$lib/api.server';
import { PAGE_SIZE } from '$lib/load-more';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// "Load more" proxy for the items catalog. Carries the archived toggle so an
// appended page matches the current view (active-only vs including archived).
export const GET: RequestHandler = async (event) => {
  const cursor = event.url.searchParams.get('cursor') ?? undefined;
  const showArchived = event.url.searchParams.get('archived') === '1';
  const client = serverApiClient(event);
  const query: Record<string, string> = { limit: String(PAGE_SIZE) };
  const companyId = cookieCompanyId(event.cookies);
  if (companyId) query.companyId = companyId;
  if (cursor) query.cursor = cursor;
  if (showArchived) query.includeArchived = 'true';
  const res = await client.api.items.$get({ query });
  if (!res.ok) return json({ rows: [], nextCursor: null }, { status: res.status });
  const { items, nextCursor } = await res.json();
  return json({ rows: items, nextCursor });
};

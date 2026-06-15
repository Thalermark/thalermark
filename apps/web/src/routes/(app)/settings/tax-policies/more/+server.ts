import { cookieCompanyId } from '$lib/active-company';
import { serverApiClient } from '$lib/api.server';
import { PAGE_SIZE } from '$lib/load-more';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// "Load more" proxy for the tax-policies list. Carries the archived toggle so
// an appended page matches the current view. Mirrors /settings/items/more.
export const GET: RequestHandler = async (event) => {
  const cursor = event.url.searchParams.get('cursor') ?? undefined;
  const showArchived = event.url.searchParams.get('archived') === '1';
  const client = serverApiClient(event);
  const query: Record<string, string> = { limit: String(PAGE_SIZE) };
  const companyId = cookieCompanyId(event.cookies);
  if (companyId) query.companyId = companyId;
  if (cursor) query.cursor = cursor;
  if (showArchived) query.includeArchived = 'true';
  const res = await client.api['tax-policies'].$get({ query });
  if (!res.ok) return json({ rows: [], nextCursor: null }, { status: res.status });
  const { taxPolicies, nextCursor } = await res.json();
  return json({ rows: taxPolicies, nextCursor });
};

import { cookieCompanyId } from '$lib/active-company';
import { serverApiClient } from '$lib/api.server';
import { PAGE_SIZE } from '$lib/load-more';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// "Load more" proxy for the trip log. No filters to carry — the list is a
// single newest-first stream.
export const GET: RequestHandler = async (event) => {
  const cursor = event.url.searchParams.get('cursor') ?? undefined;
  const client = serverApiClient(event);
  const query: Record<string, string> = { limit: String(PAGE_SIZE) };
  const companyId = cookieCompanyId(event.cookies);
  if (companyId) query.companyId = companyId;
  if (cursor) query.cursor = cursor;
  const res = await client.api['mileage-trips'].$get({ query });
  if (!res.ok) return json({ rows: [], nextCursor: null }, { status: res.status });
  const { trips, nextCursor } = await res.json();
  return json({ rows: trips, nextCursor });
};

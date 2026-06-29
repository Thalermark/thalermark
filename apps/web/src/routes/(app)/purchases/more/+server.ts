import { serverApiClient } from '$lib/api.server';
import { PAGE_SIZE } from '$lib/load-more';
import { json } from '@sveltejs/kit';
import { mapPurchaseRows } from '../purchase-rows';
import type { RequestHandler } from './$types';

// "Load more" proxy for the big-purchase list — reproduces page 1's scope.
export const GET: RequestHandler = async (event) => {
  const p = event.url.searchParams;
  const companyId = p.get('companyId') ?? '';
  if (!companyId) return json({ rows: [], nextCursor: null }, { status: 400 });
  const cursor = p.get('cursor') ?? undefined;

  const client = serverApiClient(event);
  const query: Record<string, string> = { companyId, limit: String(PAGE_SIZE) };
  if (cursor) query.cursor = cursor;

  const res = await client.api.purchases.$get({ query });
  if (!res.ok) return json({ rows: [], nextCursor: null }, { status: res.status });
  const { purchases, nextCursor } = await res.json();
  return json({ rows: mapPurchaseRows(purchases), nextCursor });
};

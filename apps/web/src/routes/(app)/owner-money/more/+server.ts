import { serverApiClient } from '$lib/api.server';
import { PAGE_SIZE } from '$lib/load-more';
import { json } from '@sveltejs/kit';
import { mapOwnerMoneyRows } from '../owner-money-rows';
import type { RequestHandler } from './$types';

// "Load more" proxy for the owner-money list. Reproduces page 1's filter set
// (companyId + kind) so the cursor walks the same result set.
export const GET: RequestHandler = async (event) => {
  const p = event.url.searchParams;
  const companyId = p.get('companyId') ?? '';
  if (!companyId) return json({ rows: [], nextCursor: null }, { status: 400 });
  const cursor = p.get('cursor') ?? undefined;

  const client = serverApiClient(event);
  const query: Record<string, string> = { companyId, limit: String(PAGE_SIZE) };
  if (cursor) query.cursor = cursor;
  const kind = p.get('kind');
  if (kind) query.kind = kind;

  const res = await client.api['owner-money'].$get({ query });
  if (!res.ok) return json({ rows: [], nextCursor: null }, { status: res.status });
  const { events, nextCursor } = await res.json();
  return json({ rows: mapOwnerMoneyRows(events), nextCursor });
};

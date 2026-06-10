import { serverApiClient } from '$lib/api.server';
import { PAGE_SIZE } from '$lib/load-more';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// Same-origin "load more" proxy for the customers list (see items/search for
// the why: keeps auth server-side, avoids browser CORS). Forwards the cursor +
// active filters to the keyset-paginated GET /api/customers and normalizes the
// response to the uniform { rows, nextCursor } the page's fetchMore() expects.
const FILTER_KEYS = ['q', 'openInvoices'] as const;

export const GET: RequestHandler = async (event) => {
  const sp = event.url.searchParams;
  const client = serverApiClient(event);
  const query: Record<string, string> = { limit: String(PAGE_SIZE) };
  const cursor = sp.get('cursor');
  if (cursor) query.cursor = cursor;
  for (const k of FILTER_KEYS) {
    const v = sp.get(k);
    if (v) query[k] = v;
  }
  const res = await client.api.customers.$get({ query });
  if (!res.ok) return json({ rows: [], nextCursor: null }, { status: res.status });
  const { customers, nextCursor } = await res.json();
  return json({ rows: customers, nextCursor });
};

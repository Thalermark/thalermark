import { cookieCompanyId } from '$lib/active-company';
import { serverApiClient } from '$lib/api.server';
import { PAGE_SIZE } from '$lib/load-more';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// "Load more" proxy for the estimates list. customerName arrives joined. The
// active filters ride along so "Load more" stays within the filtered set.
const FILTER_KEYS = ['status', 'q', 'from', 'to', 'contactId'] as const;

export const GET: RequestHandler = async (event) => {
  const sp = event.url.searchParams;
  const client = serverApiClient(event);
  const query: Record<string, string> = { limit: String(PAGE_SIZE) };
  const companyId = cookieCompanyId(event.cookies);
  if (companyId) query.companyId = companyId;
  const cursor = sp.get('cursor');
  if (cursor) query.cursor = cursor;
  for (const k of FILTER_KEYS) {
    const v = sp.get(k);
    if (v) query[k] = v;
  }
  const res = await client.api.estimates.$get({ query });
  if (!res.ok) return json({ rows: [], nextCursor: null }, { status: res.status });
  const { estimates, nextCursor } = await res.json();
  return json({ rows: estimates, nextCursor });
};

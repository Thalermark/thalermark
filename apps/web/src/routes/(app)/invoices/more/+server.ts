import { serverApiClient } from '$lib/api.server';
import { PAGE_SIZE } from '$lib/load-more';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// "Load more" proxy for the invoices list. customerName arrives joined from
// the API, so the appended rows match the SSR shape with no client lookup.
export const GET: RequestHandler = async (event) => {
  const cursor = event.url.searchParams.get('cursor') ?? undefined;
  const client = serverApiClient(event);
  const query: Record<string, string> = { limit: String(PAGE_SIZE) };
  if (cursor) query.cursor = cursor;
  const res = await client.api.invoices.$get({ query });
  if (!res.ok) return json({ rows: [], nextCursor: null }, { status: res.status });
  const { invoices, nextCursor } = await res.json();
  return json({ rows: invoices, nextCursor });
};

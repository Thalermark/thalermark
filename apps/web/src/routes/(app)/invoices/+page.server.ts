import { serverApiClient } from '$lib/api.server';
import { PAGE_SIZE } from '$lib/load-more';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// customerName is LEFT JOINed server-side now, so the list no longer fetches
// every customer to resolve names — that doesn't survive pagination.
export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const status = event.url.searchParams.get('status') ?? '';
  const query: Record<string, string> = { limit: String(PAGE_SIZE) };
  if (status) query.status = status;
  const res = await client.api.invoices.$get({ query });
  if (!res.ok) throw error(res.status, 'failed to load invoices');
  const { invoices, nextCursor } = await res.json();
  return { invoices, nextCursor, filters: { status } };
};

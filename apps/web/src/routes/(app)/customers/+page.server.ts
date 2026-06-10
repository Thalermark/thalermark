import { serverApiClient } from '$lib/api.server';
import { PAGE_SIZE } from '$lib/load-more';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Filters live in the URL: q (name or email) and openInvoices (customers with
// an issued-but-unpaid invoice). Plain GET form, fresh page 1 on submit.
export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const sp = event.url.searchParams;
  const filters = {
    q: sp.get('q') ?? '',
    openInvoices: sp.get('openInvoices') === 'true',
  };
  const query: Record<string, string> = { limit: String(PAGE_SIZE) };
  if (filters.q) query.q = filters.q;
  if (filters.openInvoices) query.openInvoices = 'true';
  const res = await client.api.customers.$get({ query });
  if (!res.ok) throw error(res.status, 'failed to load customers');
  const { customers, nextCursor } = await res.json();
  return { customers, nextCursor, filters };
};

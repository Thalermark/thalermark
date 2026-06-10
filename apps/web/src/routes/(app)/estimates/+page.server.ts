import { serverApiClient } from '$lib/api.server';
import { PAGE_SIZE } from '$lib/load-more';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// customerName is LEFT JOINed server-side (see /invoices). Filters mirror the
// invoices list: status, q (number or customer name), from/to (issueDate
// range), customerId. Customer <select> populated from a capped fetch.
export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const sp = event.url.searchParams;
  const filters = {
    status: sp.get('status') ?? '',
    q: sp.get('q') ?? '',
    from: sp.get('from') ?? '',
    to: sp.get('to') ?? '',
    customerId: sp.get('customerId') ?? '',
  };
  const query: Record<string, string> = { limit: String(PAGE_SIZE) };
  for (const [k, v] of Object.entries(filters)) {
    if (v) query[k] = v;
  }
  const [res, custRes] = await Promise.all([
    client.api.estimates.$get({ query }),
    client.api.customers.$get({ query: { limit: '500' } }),
  ]);
  if (!res.ok) throw error(res.status, 'failed to load estimates');
  const { estimates, nextCursor } = await res.json();
  const customers = custRes.ok
    ? (await custRes.json()).customers.map((c) => ({ id: c.id, name: c.name }))
    : [];
  return { estimates, nextCursor, filters, customers };
};

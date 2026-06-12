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
  // Scope both the list and the customer-filter dropdown to the active company
  // (the nav switcher's pick), resolved by the (app) layout load. Without it the
  // list — and the dropdown — span every company in the workspace.
  const { activeCompanyId } = await event.parent();
  const query: Record<string, string> = { limit: String(PAGE_SIZE) };
  if (activeCompanyId) query.companyId = activeCompanyId;
  for (const [k, v] of Object.entries(filters)) {
    if (v) query[k] = v;
  }
  const custQuery: Record<string, string> = { limit: '500' };
  if (activeCompanyId) custQuery.companyId = activeCompanyId;
  const [res, custRes] = await Promise.all([
    client.api.estimates.$get({ query }),
    client.api.customers.$get({ query: custQuery }),
  ]);
  if (!res.ok) throw error(res.status, 'failed to load estimates');
  const { estimates, nextCursor } = await res.json();
  const customers = custRes.ok
    ? (await custRes.json()).customers.map((c) => ({ id: c.id, name: c.name }))
    : [];
  return { estimates, nextCursor, filters, customers };
};

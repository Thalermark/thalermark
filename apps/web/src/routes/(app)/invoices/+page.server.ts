import { serverApiClient } from '$lib/api.server';
import { PAGE_SIZE } from '$lib/load-more';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// customerName is LEFT JOINed server-side now, so the list no longer fetches
// every contact to resolve names — that doesn't survive pagination.
//
// Filters live in the URL (shareable, back-button friendly): status, q (number
// or contact name), from/to (issueDate range), contactId. The contact
// <select> is populated from a capped contacts fetch — fine for the freelancer
// / trades audience; a type-ahead is the v1.x move if accounts get large.
export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const sp = event.url.searchParams;
  const filters = {
    status: sp.get('status') ?? '',
    q: sp.get('q') ?? '',
    from: sp.get('from') ?? '',
    to: sp.get('to') ?? '',
    contactId: sp.get('contactId') ?? '',
  };
  // Scope both the list and the contact-filter dropdown to the active company
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
    client.api.invoices.$get({ query }),
    client.api.contacts.$get({ query: custQuery }),
  ]);
  if (!res.ok) throw error(res.status, 'failed to load invoices');
  const { invoices, nextCursor } = await res.json();
  const contacts = custRes.ok
    ? (await custRes.json()).contacts.map((c) => ({ id: c.id, name: c.name }))
    : [];
  return { invoices, nextCursor, filters, contacts };
};

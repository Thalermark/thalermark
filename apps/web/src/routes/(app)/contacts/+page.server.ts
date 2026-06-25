import { serverApiClient } from '$lib/api.server';
import { PAGE_SIZE } from '$lib/load-more';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Filters live in the URL: q (name or email) and openInvoices (contacts with
// an issued-but-unpaid invoice). Plain GET form, fresh page 1 on submit.
export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const sp = event.url.searchParams;
  const filters = {
    q: sp.get('q') ?? '',
    openInvoices: sp.get('openInvoices') === 'true',
  };
  // Scope to the active company within the workspace (the nav switcher's pick),
  // resolved by the (app) layout load. Without it the list spans all companies.
  const { activeCompanyId } = await event.parent();
  const query: Record<string, string> = { limit: String(PAGE_SIZE) };
  if (activeCompanyId) query.companyId = activeCompanyId;
  if (filters.q) query.q = filters.q;
  if (filters.openInvoices) query.openInvoices = 'true';
  const res = await client.api.contacts.$get({ query });
  if (!res.ok) throw error(res.status, 'failed to load contacts');
  const { contacts, nextCursor } = await res.json();
  return { contacts, nextCursor, filters };
};

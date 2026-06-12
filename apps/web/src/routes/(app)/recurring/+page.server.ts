import { serverApiClient } from '$lib/api.server';
import { PAGE_SIZE } from '$lib/load-more';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// customerName is LEFT JOINed server-side (see /invoices).
export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  // Scope to the active company (the nav switcher's pick) from the (app) layout.
  const { activeCompanyId } = await event.parent();
  const query: Record<string, string> = { limit: String(PAGE_SIZE) };
  if (activeCompanyId) query.companyId = activeCompanyId;
  const res = await client.api['recurring-invoices'].$get({ query });
  if (!res.ok) throw error(res.status, 'failed to load recurring invoices');
  const { recurringInvoices, nextCursor } = await res.json();
  return { schedules: recurringInvoices, nextCursor };
};

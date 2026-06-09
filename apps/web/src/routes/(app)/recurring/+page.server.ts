import { serverApiClient } from '$lib/api.server';
import { PAGE_SIZE } from '$lib/load-more';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// customerName is LEFT JOINed server-side (see /invoices).
export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const res = await client.api['recurring-invoices'].$get({ query: { limit: String(PAGE_SIZE) } });
  if (!res.ok) throw error(res.status, 'failed to load recurring invoices');
  const { recurringInvoices, nextCursor } = await res.json();
  return { schedules: recurringInvoices, nextCursor };
};

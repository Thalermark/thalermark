import { serverApiClient } from '$lib/api.server';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const [recurringRes, customersRes] = await Promise.all([
    client.api['recurring-invoices'].$get(),
    client.api.customers.$get(),
  ]);
  if (!recurringRes.ok) throw error(recurringRes.status, 'failed to load recurring invoices');
  if (!customersRes.ok) throw error(customersRes.status, 'failed to load customers');
  const { recurringInvoices } = await recurringRes.json();
  const { customers } = await customersRes.json();
  const customerNameById = new Map(customers.map((c) => [c.id, c.name]));
  return {
    schedules: recurringInvoices.map((s) => ({
      ...s,
      customerName: customerNameById.get(s.customerId) ?? '—',
    })),
  };
};

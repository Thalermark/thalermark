import { serverApiClient } from '$lib/api.server';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const [invoicesRes, customersRes] = await Promise.all([
    client.api.invoices.$get(),
    client.api.customers.$get(),
  ]);
  if (!invoicesRes.ok) throw error(invoicesRes.status, 'failed to load invoices');
  if (!customersRes.ok) throw error(customersRes.status, 'failed to load customers');
  const { invoices } = await invoicesRes.json();
  const { customers } = await customersRes.json();
  const customerNameById = new Map(customers.map((c) => [c.id, c.name]));
  return {
    invoices: invoices.map((inv) => ({
      ...inv,
      customerName: customerNameById.get(inv.customerId) ?? '—',
    })),
  };
};

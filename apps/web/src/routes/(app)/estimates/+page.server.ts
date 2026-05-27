import { serverApiClient } from '$lib/api.server';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const [estimatesRes, customersRes] = await Promise.all([
    client.api.estimates.$get(),
    client.api.customers.$get(),
  ]);
  if (!estimatesRes.ok) throw error(estimatesRes.status, 'failed to load estimates');
  if (!customersRes.ok) throw error(customersRes.status, 'failed to load customers');
  const { estimates } = await estimatesRes.json();
  const { customers } = await customersRes.json();
  const customerNameById = new Map(customers.map((c) => [c.id, c.name]));
  return {
    estimates: estimates.map((est) => ({
      ...est,
      customerName: customerNameById.get(est.customerId) ?? '—',
    })),
  };
};

import { serverApiClient } from '$lib/api.server';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const invoiceRes = await client.api.invoices[':id'].$get({ param: { id: event.params.id } });
  if (invoiceRes.status === 404) throw error(404, 'invoice not found');
  if (!invoiceRes.ok) throw error(invoiceRes.status, 'failed to load invoice');
  const invoice = await invoiceRes.json();

  const customerRes = await client.api.customers[':id'].$get({
    param: { id: invoice.customerId },
  });
  const customer = customerRes.ok ? await customerRes.json() : null;

  return { invoice, customer };
};

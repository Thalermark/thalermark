import { serverApiClient } from '$lib/api.server';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Top-products report. `?basis=sent` flips the cash (paid-only) default to the
// accrual-ish "sent or paid" view; the API validates the value. Single-company
// MVP auto-picks the first company.
export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const companiesRes = await client.api.companies.$get();
  if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
  const { companies } = await companiesRes.json();
  const company = companies[0];
  if (!company) throw error(500, 'no company on this account');

  const basis = event.url.searchParams.get('basis') === 'sent' ? 'sent' : 'paid';
  const res = await client.api.companies[':id']['top-products'].$get({
    param: { id: company.id },
    query: { basis },
  });
  if (!res.ok) throw error(res.status, 'failed to load report');
  const { products } = await res.json();

  return { basis, products };
};

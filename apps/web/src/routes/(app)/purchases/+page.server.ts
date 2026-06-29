import { pickActiveCompany } from '$lib/active-company';
import { serverApiClient } from '$lib/api.server';
import { PAGE_SIZE } from '$lib/load-more';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { mapPurchaseRows } from './purchase-rows';

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);

  const companiesRes = await client.api.companies.$get();
  if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
  const { companies } = await companiesRes.json();
  const company = pickActiveCompany(event.cookies, companies);
  if (!company) throw error(500, 'no company in this workspace');

  const res = await client.api.purchases.$get({
    query: { companyId: company.id, limit: String(PAGE_SIZE) },
  });
  if (!res.ok) throw error(res.status, 'failed to load purchases');
  const { purchases, nextCursor } = await res.json();

  return { rows: mapPurchaseRows(purchases), nextCursor, companyId: company.id };
};

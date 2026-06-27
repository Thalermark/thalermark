import { pickActiveCompany } from '$lib/active-company';
import { serverApiClient } from '$lib/api.server';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// AP aging — open bills bucketed by how far past due they are. The payable
// mirror of an AR aging report.
export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);

  const companiesRes = await client.api.companies.$get();
  if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
  const { companies } = await companiesRes.json();
  const company = pickActiveCompany(event.cookies, companies);
  if (!company) throw error(500, 'no company in this workspace');

  const res = await client.api.bills.aging.$get({ query: { companyId: company.id } });
  if (!res.ok) throw error(res.status, 'failed to load aging report');
  const aging = await res.json();

  return { aging };
};

import { pickActiveCompany } from '$lib/active-company';
import { serverApiClient } from '$lib/api.server';
import { PAGE_SIZE } from '$lib/load-more';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { mapLedgerRows } from './ledger-rows';

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);

  // The active company within this workspace (cookie-backed switcher), same as
  // every other list; manual entries are scoped to it.
  const companiesRes = await client.api.companies.$get();
  if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
  const { companies } = await companiesRes.json();
  const company = pickActiveCompany(event.cookies, companies);
  if (!company) throw error(500, 'no company in this workspace');

  const res = await client.api.ledger.entries.$get({
    query: { companyId: company.id, limit: String(PAGE_SIZE) },
  });
  if (!res.ok) throw error(res.status, 'failed to load ledger entries');
  const { entries, nextCursor } = await res.json();

  return { rows: mapLedgerRows(entries), nextCursor, companyId: company.id };
};

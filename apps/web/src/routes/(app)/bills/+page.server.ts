import { pickActiveCompany } from '$lib/active-company';
import { serverApiClient } from '$lib/api.server';
import { PAGE_SIZE } from '$lib/load-more';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { mapBillRows } from './bill-rows';

// The bills (accounts payable) list — money you owe vendors. Scoped to the
// active company (cookie-backed switcher), same as expenses. The status filter
// lives in the URL (?status=open|paid|voided) so it's shareable + no-JS.
export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);

  const companiesRes = await client.api.companies.$get();
  if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
  const { companies } = await companiesRes.json();
  const company = pickActiveCompany(event.cookies, companies);
  if (!company) throw error(500, 'no company in this workspace');

  const status = event.url.searchParams.get('status') ?? '';

  const query: Record<string, string> = { companyId: company.id, limit: String(PAGE_SIZE) };
  if (status) query.status = status;

  const [billsRes, accountsRes] = await Promise.all([
    client.api.bills.$get({ query }),
    client.api.companies[':id'].accounts.$get({
      param: { id: company.id },
      query: { type: 'expense' },
    }),
  ]);
  if (!billsRes.ok) throw error(billsRes.status, 'failed to load bills');
  if (!accountsRes.ok) throw error(accountsRes.status, 'failed to load categories');

  const { bills, nextCursor } = await billsRes.json();
  const { accounts } = await accountsRes.json();
  const categoryNameById = new Map(accounts.map((a) => [a.id, a.name]));

  return {
    rows: mapBillRows(bills, categoryNameById),
    nextCursor,
    companyId: company.id,
    filters: { status },
  };
};

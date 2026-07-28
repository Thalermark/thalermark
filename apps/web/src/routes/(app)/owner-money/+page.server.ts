import { pickActiveCompany } from '$lib/active-company';
import { serverApiClient } from '$lib/api.server';
import { PAGE_SIZE } from '$lib/load-more';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { mapOwnerMoneyRows } from './owner-money-rows';

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);

  // The active company within this workspace (cookie-backed switcher), same as
  // the expense/bill lists; every list is scoped to it.
  const companiesRes = await client.api.companies.$get();
  if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
  const { companies } = await companiesRes.json();
  const company = pickActiveCompany(event.cookies, companies);
  if (!company) throw error(500, 'no company in this workspace');

  // 'contribution' | 'draw' | '' (all). Only forward when set.
  const kind = event.url.searchParams.get('kind') ?? '';

  const query: Record<string, string> = { companyId: company.id, limit: String(PAGE_SIZE) };
  if (kind) query.kind = kind;

  const res = await client.api['owner-money'].$get({ query });
  if (!res.ok) throw error(res.status, 'failed to load owner money');
  const { events, nextCursor } = await res.json();

  // The starting-balances fetch that used to feed a summary card here is gone
  // with the card — that's setup, and it lives in Settings now. It also always
  // showed the simple shape's cash figure, so a company that had entered a full
  // trial balance saw one number standing in for a dozen.

  return {
    rows: mapOwnerMoneyRows(events),
    nextCursor,
    companyId: company.id,
    filters: { kind },
  };
};

import { serverApiClient } from '$lib/api.server';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

const PERIODS = ['month', '30d', 'ytd'] as const;
type Period = (typeof PERIODS)[number];

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);

  // Single-company assumption, same as the lists/forms: the active company is
  // companies[0] until a multi-company switcher lands.
  const companiesRes = await client.api.companies.$get();
  if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
  const { companies } = await companiesRes.json();
  const company = companies[0];
  if (!company) throw error(500, 'no company on this account');

  const requested = event.url.searchParams.get('period');
  const period: Period = PERIODS.includes(requested as Period) ? (requested as Period) : 'month';

  // The query validator types all three keys; we only drive `period` from the
  // dashboard (from/to are the deterministic-caller path). undefined keys are
  // dropped from the query string by the client.
  const res = await client.api.companies[':id'].dashboard.$get({
    param: { id: company.id },
    query: { period, from: undefined, to: undefined },
  });
  if (!res.ok) throw error(res.status, 'failed to load dashboard');
  const dashboard = await res.json();

  return { dashboard, period, companyName: company.name };
};

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

  // Spending anomalies (deterministic, cheap) — fetched inline, not streamed:
  // no model call, so it resolves with the position. Best-effort: a non-OK
  // degrades to no anomalies rather than failing the page.
  const anomaliesRes = await client.api.companies[':id']['spending-anomalies'].$get({
    param: { id: company.id },
  });
  const anomalies = anomaliesRes.ok
    ? await anomaliesRes.json()
    : { enoughHistory: false, overall: null, categories: [] };

  // Cash-flow nudges (AI) stream in separately: the position tiles render
  // immediately while this promise resolves. A cache hit on the API returns
  // instantly; a regeneration shows the page's spinner. Any non-OK (no AI
  // configured → 503, or a model error → 502) degrades to no nudges rather
  // than failing the dashboard. The promise is returned UN-awaited so
  // SvelteKit streams it.
  const nudges = (async () => {
    const r = await client.api.companies[':id']['cash-flow-nudges'].$get({
      param: { id: company.id },
    });
    if (!r.ok) return { nudges: [] };
    return await r.json();
  })();

  // State-driven setup nudge: surfaces while the business address is unset and
  // resolves itself the moment it's filled in (Settings → Business). No
  // run-once flag / localStorage — the company row is the source of truth, so
  // it's correct across web + mobile and can't be dismissed into oblivion.
  const needsBusinessDetails = !company.businessAddress;

  return {
    dashboard,
    period,
    companyName: company.name,
    needsBusinessDetails,
    nudges,
    anomalies,
  };
};

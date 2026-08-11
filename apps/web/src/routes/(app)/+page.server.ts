import { pickActiveCompany } from '$lib/active-company';
import { serverApiClient } from '$lib/api.server';
import { fillMonths } from '$lib/reports.server';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

const PERIODS = ['month', '30d', 'ytd'] as const;
type Period = (typeof PERIODS)[number];

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);

  // The active company within this workspace (cookie-backed switcher); falls
  // back to the first company for single-company accounts.
  const companiesRes = await client.api.companies.$get();
  if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
  const { companies } = await companiesRes.json();
  const company = pickActiveCompany(event.cookies, companies);
  if (!company) throw error(500, 'no company in this workspace');

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

  // Point-in-time entity counts for the count-tile row (NOT period-bound, so
  // they ignore the period toggle): invoices split into overdue / awaiting /
  // draft, plus open (sent) estimates. Cheap COUNT aggregates; best-effort —
  // a non-OK degrades to zeros rather than failing the dashboard.
  const [invSummaryRes, estSummaryRes] = await Promise.all([
    client.api.invoices.summary.$get({ query: { companyId: company.id } }),
    client.api.estimates.summary.$get({ query: { companyId: company.id } }),
  ]);
  const invSummary = invSummaryRes.ok ? await invSummaryRes.json() : null;
  const estSummary = estSummaryRes.ok ? await estSummaryRes.json() : null;
  const counts = {
    overdue: invSummary?.overdue.count ?? 0,
    awaiting: invSummary?.awaiting.count ?? 0,
    drafts: invSummary?.draft.count ?? 0,
    openEstimates: estSummary?.open.count ?? 0,
    // The customer said yes and nothing has been billed for it (TMC-230).
    // Accepting is the highest-value event in the product and it notified
    // nobody; worse, the estimate left the "open" tile on acceptance, so the
    // one surface that tracked it stopped showing it at the exact moment it
    // became actionable.
    acceptedEstimates: estSummary?.acceptedUnbilled.count ?? 0,
    // Invoices whose email did not arrive (TMC-226). Before this the only trace
    // of a bounced or refused send was a log line on the server, so an invoice
    // that never reached anyone looked exactly like one being ignored.
    undelivered: invSummary?.undelivered.count ?? 0,
  };

  // Twelve months of billed revenue, for the sparkline under "Money in".
  //
  // The dashboard's own figures are point-in-time scalars — they answer "how
  // much", never "which way". A single number is the one thing a business
  // owner cannot act on: $6,000 is good news or bad news entirely depending on
  // what the last few months looked like.
  //
  // Reuses the revenue-over-time report rather than growing a dashboard
  // endpoint: it is the same arithmetic, already gap-filled, and sharing it
  // means the tile and the report can never disagree. Best-effort like the
  // summaries above — a failed fetch drops the sparkline, not the dashboard.
  const trendTo = new Date();
  const trendFrom = new Date(trendTo.getFullYear(), trendTo.getMonth() - 11, 1);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const trendRes = await client.api.companies[':id']['revenue-over-time'].$get({
    param: { id: company.id },
    query: { from: iso(trendFrom), to: iso(trendTo) },
  });
  // GAP-FILLED, which is not optional. The API returns only months that had
  // sales, so feeding `months` straight in would draw June and August as
  // adjacent points and hide the empty July between them — a trend line that
  // silently omits the bad months is worse than no trend line.
  const revenueTrend = trendRes.ok
    ? await trendRes.json().then((r) => fillMonths(r.from, r.to, r.months).map((m) => m.revenue))
    : ([] as string[]);

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

  // Pending workspace invitations addressed to this user (bootstrap route, no
  // company scope) → a dashboard notice linking to the Workspace screen where
  // they can accept/decline. Best-effort: a non-OK degrades to no notice.
  let pendingInvites = 0;
  const invitesRes = await client.api.me.invitations.$get();
  if (invitesRes.ok) pendingInvites = (await invitesRes.json()).invitations.length;

  return {
    dashboard,
    period,
    companyName: company.name,
    needsBusinessDetails,
    pendingInvites,
    nudges,
    anomalies,
    counts,
    revenueTrend,
  };
};

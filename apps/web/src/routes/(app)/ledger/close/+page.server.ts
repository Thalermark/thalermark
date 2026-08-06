import { pickActiveCompany } from '$lib/active-company';
import { serverApiClient } from '$lib/api.server';
import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

// Year-end close (TMC-159). Behind The Ledger's airlock and the `ledger:adjust`
// capability, because closing a year is an accountant's act — but the copy
// stays plain: the user reads "close out 2025", never "closing entries".
//
// The page offers every finished year that isn't already closed, newest first,
// each with a preview of what would roll. The preview is a separate call per
// year so the figure shown is the one the close will actually post.

// How many finished years back to offer. Far enough to cover a business that
// starts using Thalermark with a couple of years of history to tidy up, short
// enough that the page doesn't become a list of empty years.
const YEARS_OFFERED = 4;

type Closable = {
  fiscalYear: number;
  netIncome: string;
  withdrawals: string;
  equityLabel: string;
  empty: boolean;
};

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);

  const companiesRes = await client.api.companies.$get();
  if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
  const { companies } = await companiesRes.json();
  const company = pickActiveCompany(event.cookies, companies);
  if (!company) throw error(500, 'no company in this workspace');

  const closesRes = await client.api.ledger['period-closes'].$get({
    query: { companyId: company.id },
  });
  if (!closesRes.ok) throw error(closesRes.status, 'failed to load year-end closes');
  const { closes } = await closesRes.json();

  // Only years that are over can be closed, and only the ones not yet closed
  // are worth previewing. A later closed year locks the earlier ones, so once
  // any year is closed the only candidates are the ones after it.
  const closedYears = new Set(closes.map((c) => c.fiscalYear));
  const newestClosed = closes.length > 0 ? Math.max(...closes.map((c) => c.fiscalYear)) : null;
  // Local year, matching mobile. The server is the authority either way — it
  // resolves the boundary in the COMPANY's timezone and refuses a year that
  // hasn't finished there, so an offered-but-unfinished year is filtered out
  // below when its preview comes back not-ok.
  const lastFinished = new Date().getFullYear() - 1;

  const candidates: number[] = [];
  for (let y = lastFinished; y > lastFinished - YEARS_OFFERED; y--) {
    if (closedYears.has(y)) continue;
    if (newestClosed !== null && y < newestClosed) continue;
    candidates.push(y);
  }

  const previews = await Promise.all(
    candidates.map(async (fiscalYear): Promise<Closable | null> => {
      const res = await client.api.ledger['period-closes'].preview.$get({
        query: { companyId: company.id, fiscalYear: String(fiscalYear) },
      });
      // A year the server refuses (not finished in the company's zone, already
      // covered by a later close) simply isn't offered.
      if (!res.ok) return null;
      const p = await res.json();
      return {
        fiscalYear,
        netIncome: p.netIncome,
        withdrawals: p.withdrawals,
        equityLabel: p.equityLabel,
        empty: p.empty,
      };
    }),
  );

  const offered = previews.filter((p): p is Closable => p !== null);

  // Vehicles missing the Part IV answers the return needs (TMC-179). Surfaced
  // here as a LINK rather than a form: the answers aren't period-locked, so they
  // can be given before or after a close, and a second copy of the form would be
  // a second thing to keep right. Fail-soft — a hiccup hides the prompt rather
  // than breaking the close page.
  let vehiclesNeedingAnswers = 0;
  try {
    const vehiclesRes = await client.api.vehicles.$get({ query: { companyId: company.id } });
    if (vehiclesRes.ok) {
      const { vehicles } = await vehiclesRes.json();
      vehiclesNeedingAnswers = vehicles.filter(
        (v) => v.personalUse === null || v.placedInServiceOn === null,
      ).length;
    }
  } catch {
    vehiclesNeedingAnswers = 0;
  }

  return {
    companyId: company.id,
    vehiclesNeedingAnswers,
    // Only years with something on them get a card. A business that started last
    // year would otherwise meet a wall of identical "nothing here" cards with no
    // action on them; the empty years are named in one line instead, so it's
    // still clear why they aren't listed.
    closable: offered.filter((p) => !p.empty),
    emptyYears: offered.filter((p) => p.empty).map((p) => p.fiscalYear),
    closes: closes.map((c) => ({
      id: c.id,
      fiscalYear: c.fiscalYear,
      netIncome: c.netIncome,
      closedAt: c.closedAt.slice(0, 10),
    })),
    // Only the newest close can be re-opened — re-opening an earlier one would
    // leave it locked by the later close anyway.
    reopenableId: closes.length > 0 ? closes[0]?.id : undefined,
  };
};

export const actions: Actions = {
  close: async (event) => {
    const client = serverApiClient(event);
    const data = await event.request.formData();
    const fiscalYear = Number(data.get('fiscalYear'));

    const companiesRes = await client.api.companies.$get();
    if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
    const { companies } = await companiesRes.json();
    const companyId = pickActiveCompany(event.cookies, companies)?.id;
    if (!companyId) return fail(400, { formError: 'No company in this workspace.' });

    const res = await client.api.ledger['period-closes'].$post({
      json: { companyId, fiscalYear },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, { formError: closeErrorMessage(body?.error, fiscalYear) });
    }
    return { closedYear: fiscalYear };
  },

  reopen: async (event) => {
    const client = serverApiClient(event);
    const data = await event.request.formData();
    const id = String(data.get('id') ?? '');

    const res = await client.api.ledger['period-closes'][':id'].reopen.$post({ param: { id } });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      const message =
        body?.error === 'later_year_still_closed'
          ? 'Re-open the most recent year first.'
          : 'Could not re-open that year.';
      return fail(res.status, { formError: message });
    }
    const reopened = await res.json();
    return { reopenedYear: reopened.fiscalYear };
  },
};

// Server error codes are accounting-shaped; the user reads plain sentences.
function closeErrorMessage(code: string | undefined, fiscalYear: number): string {
  switch (code) {
    case 'year_not_finished':
      return `${fiscalYear} isn't over yet.`;
    case 'already_closed':
      return `${fiscalYear} is already closed.`;
    case 'later_year_closed':
      return 'A more recent year is already closed. Re-open it first.';
    case 'nothing_to_close':
      return `There's nothing on the books for ${fiscalYear}.`;
    case 'equity_account_missing':
      return 'This business is missing an equity account. Contact support.';
    default:
      return 'Could not close that year.';
  }
}

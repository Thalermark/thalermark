import { pickActiveCompany } from '$lib/active-company';
import { serverApiClient } from '$lib/api.server';
import { may } from '$lib/perms';
import type { PageServerLoad } from './$types';

// Surface the active workspace role so the hub can gate the General ledger card
// (reports:export — owner/admin/accountant only). Every other role-gated page
// has its own loader; without one here the hub is a prerender candidate and
// `data.role` would resolve to build-time `undefined`, hiding the card for
// everyone. The export endpoint stays the real authority either way.
export const load: PageServerLoad = async (event) => {
  const role = event.locals.role;

  // Two nudges live here for the same reason: the reports hub is where people
  // land at tax time, so the prompt goes here even when the action doesn't.
  //
  // They have DIFFERENT audiences, which is why the vehicle check is computed
  // before the ledger:adjust gate rather than after it. The close is an
  // accountant's job; finishing Part IV is the job of whoever drives the truck,
  // and that person routinely holds neither ledger:adjust nor settings:manage.
  // Folding the vehicle check in behind the close gate would hide it from
  // exactly the person it is for.
  //
  // Both fail soft: the hub is otherwise a static index, so a hiccup on either
  // lookup degrades to "no nudge" rather than breaking the page.
  const empty = { role, unclosedYear: null, vehiclesNeedingAnswers: 0 };

  try {
    const client = serverApiClient(event);
    const companiesRes = await client.api.companies.$get();
    if (!companiesRes.ok) return empty;
    const { companies } = await companiesRes.json();
    const company = pickActiveCompany(event.cookies, companies);
    if (!company) return empty;

    // Part IV cannot be filed without these, and they are answerable any day of
    // the year — so the prompt is not gated on the year being over.
    let vehiclesNeedingAnswers = 0;
    const vehiclesRes = await client.api.vehicles.$get({ query: { companyId: company.id } });
    if (vehiclesRes.ok) {
      const { vehicles } = await vehiclesRes.json();
      vehiclesNeedingAnswers = vehicles.filter(
        (v) => v.personalUse === null || v.placedInServiceOn === null,
      ).length;
    }

    // Year-end close nudge (TMC-159). The close itself lives behind The Ledger's
    // airlock, which someone who never opens that portal will never find — and
    // for a corporation an unclosed year means Schedule L reports the wrong
    // retained earnings forever.
    if (!may(role, 'ledger:adjust')) return { ...empty, vehiclesNeedingAnswers };

    const res = await client.api.ledger['period-closes'].$get({
      query: { companyId: company.id },
    });
    if (!res.ok) return { ...empty, vehiclesNeedingAnswers };
    const { closes } = await res.json();

    const lastFinished = new Date().getUTCFullYear() - 1;
    const alreadyClosed = closes.some((c) => c.fiscalYear >= lastFinished);
    return {
      role,
      unclosedYear: alreadyClosed ? null : lastFinished,
      vehiclesNeedingAnswers,
    };
  } catch {
    return empty;
  }
};

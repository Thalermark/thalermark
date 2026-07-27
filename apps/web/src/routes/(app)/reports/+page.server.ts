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

  // Year-end close nudge (TMC-159). The close itself lives behind The Ledger's
  // airlock, which someone who never opens that portal will never find — and for
  // a corporation an unclosed year means Schedule L reports the wrong retained
  // earnings forever. The reports hub is where people land at tax time, so the
  // prompt goes here even though the action doesn't.
  //
  // Only shown to roles that can actually do it, and deliberately fail-soft: the
  // hub is otherwise a static index, so a hiccup on this lookup degrades to "no
  // nudge" rather than breaking the page.
  if (!may(role, 'ledger:adjust')) return { role, unclosedYear: null };

  try {
    const client = serverApiClient(event);
    const companiesRes = await client.api.companies.$get();
    if (!companiesRes.ok) return { role, unclosedYear: null };
    const { companies } = await companiesRes.json();
    const company = pickActiveCompany(event.cookies, companies);
    if (!company) return { role, unclosedYear: null };

    const res = await client.api.ledger['period-closes'].$get({
      query: { companyId: company.id },
    });
    if (!res.ok) return { role, unclosedYear: null };
    const { closes } = await res.json();

    const lastFinished = new Date().getUTCFullYear() - 1;
    const alreadyClosed = closes.some((c) => c.fiscalYear >= lastFinished);
    return { role, unclosedYear: alreadyClosed ? null : lastFinished };
  } catch {
    return { role, unclosedYear: null };
  }
};

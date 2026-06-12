import { ACTIVE_COMPANY_COOKIE, pickActiveCompany, setActiveCompany } from '$lib/active-company';
import { serverApiClient } from '$lib/api.server';
import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

// First-run gate. Any (app) route load forces a fresh signup through the
// /welcome wizard if the active company has no business_type set yet, so the
// operator's real entity-type answer is captured (and the company named) before
// they start booking transactions. The COA seeded at signup is sole-prop
// regardless of the pick (per the locked decision) — the column is just captured
// for the v1.x entity-aware re-seed. Step 1 of the wizard sets business_type,
// which satisfies this gate, so the optional later steps never force a re-entry.
//
// The /welcome wizard lives OUTSIDE the (app) group (its own focused layout), so
// it isn't subject to this load at all — no exemption needed for it here.
// /select-company stays exempt because that flow predates the active company
// even being addressable.
const REDIRECT_EXEMPT = new Set(['/select-company']);

export const load: LayoutServerLoad = async (event) => {
  if (!event.locals.activeAccountId) return {};
  if (REDIRECT_EXEMPT.has(event.url.pathname)) return {};

  const client = serverApiClient(event);
  const res = await client.api.companies.$get();
  if (!res.ok) return {};
  const { companies } = await res.json();
  if (companies.some((c) => c.businessType === null)) {
    throw redirect(303, '/welcome');
  }
  // Feed the nav company switcher (UserMenu). The first-run gate already
  // fetched the list, so surfacing it + the active pick costs nothing extra.
  const active = pickActiveCompany(event.cookies, companies);
  // Heal the cookie to the resolved active company whenever it's missing or
  // stale (e.g. a company id left from another workspace). Keeps the raw cookie
  // trustworthy for the load-more / search +server proxies that read it
  // directly. Takes effect from the next request — page loads here use the
  // validated activeCompanyId below (via parent()), so first render is correct.
  if (active && event.cookies.get(ACTIVE_COMPANY_COOKIE) !== active.id) {
    setActiveCompany(event.cookies, active.id);
  }
  return {
    companies: companies.map((c) => ({ id: c.id, name: c.name })),
    activeCompanyId: active?.id ?? null,
  };
};

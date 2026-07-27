import { ACTIVE_COMPANY_COOKIE, pickActiveCompany, setActiveCompany } from '$lib/active-company';
import { serverApiClient } from '$lib/api.server';
import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

// First-run gate. Any (app) route load forces a fresh signup through the
// /welcome wizard if the active company has no business_type set yet, so the
// operator's real entity-type answer is captured (and the company named) before
// they start booking transactions. Signup seeds a provisional sole-prop chart of
// accounts (it has no answer yet); the wizard's pick re-maps that chart onto the
// return the business actually files. Step 1 of the wizard sets business_type,
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
  // Retired companies are exempt from the first-run gate. A business that has
  // stopped trading is never going to answer the welcome wizard, so counting one
  // here would pin the user at /welcome permanently with no way out.
  if (companies.some((c) => c.businessType === null && !c.retiredAt)) {
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

  // Telemetry consent state. Fed to every (app) page for two consumers: the
  // first-run prompt (gated to settings:manage roles in the layout) and the
  // client emitter's enabled flag (needed by every user, since report views
  // come from any member). GET is open to members; a failed fetch just omits it.
  let telemetry: { enabled: boolean; decided: boolean; disabled: boolean } | null = null;
  const telRes = await client.api.account.telemetry.$get();
  if (telRes.ok) telemetry = await telRes.json();

  // Legal-consent state (spikes/SIGN-UP-ACK-TOS.md). Drives the blocking wall in
  // the layout: when required && !accepted, the (app) content is replaced by the
  // Terms/Privacy gate. required:false on a default self-host → no wall, at the
  // cost of one cheap GET (mirrors the telemetry fetch above). A failed fetch
  // just omits it (no wall).
  let legal: {
    required: boolean;
    version: string | null;
    accepted: boolean;
    termsUrl: string | null;
    privacyUrl: string | null;
  } | null = null;
  const legalRes = await client.api.legal.$get();
  if (legalRes.ok) legal = await legalRes.json();

  return {
    // retiredAt rides along so the switcher can group closed businesses and the
    // layout can say when you're looking at one.
    companies: companies.map((c) => ({ id: c.id, name: c.name, retiredAt: c.retiredAt })),
    activeCompanyId: active?.id ?? null,
    // Which federal return the active business files, for the surfaces that are
    // entity-specific (the Schedule C worksheet is only some businesses'). Rides
    // the list this load already fetched, and layout data merges into every
    // child page's `data`, so no page needs its own lookup.
    activeBusinessType: active?.businessType ?? null,
    telemetry,
    legal,
  };
};

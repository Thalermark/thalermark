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
  return {};
};

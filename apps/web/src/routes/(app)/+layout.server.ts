import { serverApiClient } from '$lib/api.server';
import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

// Slice L3 — first-run gate. Any (app) route load forces the operator
// through /setup if the active company has no business_type set yet, so
// the ledger has the operator's real entity-type answer captured before
// they start booking transactions. The COA seeded at signup is sole-prop
// regardless of the pick (per the locked decision) — the column is just
// captured for the v1.x entity-aware re-seed.
//
// Excludes /setup itself so the wizard can render, and /select-company
// because that flow predates the active company even being addressable.
const REDIRECT_EXEMPT = new Set(['/setup', '/select-company']);

export const load: LayoutServerLoad = async (event) => {
  if (!event.locals.activeAccountId) return {};
  if (REDIRECT_EXEMPT.has(event.url.pathname)) return {};

  const client = serverApiClient(event);
  const res = await client.api.companies.$get();
  if (!res.ok) return {};
  const { companies } = await res.json();
  if (companies.some((c) => c.businessType === null)) {
    throw redirect(303, '/setup');
  }
  return {};
};

import { serverApiClient } from '$lib/api.server';
import { error, redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

// The welcome wizard sets up the operator's first company right after signup.
// It lives OUTSIDE the (app) group on purpose: it wants focused chrome (no app
// nav) and must not run (app)'s first-run gate, which would otherwise bounce a
// half-finished wizard around. Auth + active-account resolution still apply —
// hooks.server.ts gates every non-public path, so a logged-out user never lands
// here. The (app) layout redirects new signups in (businessType === null);
// Step 1 sets the type, which satisfies that gate so the user is never forced
// back through the optional steps.
//
// One load for the whole wizard: the company's current values feed every step
// (name/type → Step 1, payment fields → Step 2). The logo (a separate fetch) is
// loaded by Step 3 alone, so the other steps don't pay for it.
export const load: LayoutServerLoad = async (event) => {
  const client = serverApiClient(event);
  const res = await client.api.companies.$get();
  if (!res.ok) throw error(res.status, 'failed to load your business');
  const { companies } = await res.json();
  // The company still trading — a retired one has stopped, and setting it up
  // would be pointless. Falls back to the first company so a workspace whose
  // companies are all retired still renders something rather than bouncing.
  const company = companies.find((c) => !c.retiredAt) ?? companies[0];
  // No company means signup never provisioned one (0-membership / invited-only
  // user who hasn't created a business). Send them to the account picker, which
  // owns that empty state — the wizard has nothing to set up.
  if (!company) throw redirect(303, '/select-company');
  return { company };
};

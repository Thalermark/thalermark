import { setActiveCompany } from '$lib/active-company';
import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// Sets the active-company cookie, then bounces back to where the user was.
// No ownership check is needed here: pickActiveCompany only honors the cookie
// when the id is actually in the account's company list, so a bogus or stale
// value harmlessly falls back to the first company. Switching is read-level —
// every role may view their workspace's companies — so there's no capability
// gate (creating one is gated; viewing/switching is not).
export const POST: RequestHandler = async (event) => {
  const form = await event.request.formData();
  const companyId = String(form.get('companyId') ?? '');
  if (companyId) setActiveCompany(event.cookies, companyId);

  // Only same-origin local paths (single leading slash) — never an open redirect.
  const returnTo = String(form.get('returnTo') ?? '/');
  const target = returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/';
  throw redirect(303, target);
};

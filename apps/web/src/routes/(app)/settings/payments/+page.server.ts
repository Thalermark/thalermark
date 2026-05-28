import { serverApiClient } from '$lib/api.server';
import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const companiesRes = await client.api.companies.$get();
  if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
  const { companies } = await companiesRes.json();

  // MVP: one company per account is the common path; the same first-company
  // pick lives in /invoices/new. The Connect onboarding is per-company —
  // when the multi-company picker arrives we'll surface a row per company
  // here and onboard each independently.
  const company = companies[0];
  if (!company) throw error(500, 'no company on this account');

  const statusRes = await client.api.companies[':id']['stripe-connect'].status.$get({
    param: { id: company.id },
  });
  if (!statusRes.ok) throw error(statusRes.status, 'failed to load stripe status');
  const status = await statusRes.json();

  // Stripe redirects back here with ?stripe=return when onboarding finishes
  // and ?stripe=refresh when the user wants a fresh link. Either way the
  // current status query above is the source of truth — the webhook keeps
  // the flags fresh, so the post-return render shows the real state.
  const stripeReturn = event.url.searchParams.get('stripe');

  return {
    company,
    status,
    stripeReturn,
  };
};

export const actions: Actions = {
  // Kicks off (or refreshes) Stripe Connect onboarding for the active
  // company. The API mints a fresh Account Link each call so a 303 to
  // Stripe is always safe. Plain HTML form action — no use:enhance, in
  // line with the rest of the app's no-JS path.
  onboard: async (event) => {
    const client = serverApiClient(event);
    const formData = await event.request.formData();
    const companyId = String(formData.get('companyId') ?? '');
    if (!companyId) return fail(400, { onboardError: 'missing_company_id' });

    const res = await client.api.companies[':id']['stripe-connect'].onboard.$post({
      param: { id: companyId },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, { onboardError: body?.error ?? 'onboard_failed' });
    }
    const { url } = await res.json();
    redirect(303, url);
  },
};

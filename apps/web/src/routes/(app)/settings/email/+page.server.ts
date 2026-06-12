import { pickActiveCompany } from '$lib/active-company';
import { serverApiClient } from '$lib/api.server';
import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const companiesRes = await client.api.companies.$get();
  if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
  const { companies } = await companiesRes.json();

  // The active company within this workspace (cookie-backed switcher), same
  // pick as /settings/payments; falls back to the first for single-company.
  const company = pickActiveCompany(event.cookies, companies);
  if (!company) throw error(500, 'no company in this workspace');

  return { company };
};

export const actions: Actions = {
  // Saves the reply-to address. Empty input clears it (API coerces '' → null,
  // which drops the Reply-To header from outbound invoice/estimate emails).
  // Plain HTML form action — no use:enhance, matching the rest of settings.
  save: async (event) => {
    const client = serverApiClient(event);
    const formData = await event.request.formData();
    const companyId = String(formData.get('companyId') ?? '');
    const replyToEmail = String(formData.get('replyToEmail') ?? '').trim();
    if (!companyId) return fail(400, { error: 'missing_company_id' });

    const res = await client.api.companies[':id'].$patch({
      param: { id: companyId },
      json: { replyToEmail },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, { error: body?.error ?? 'save_failed', replyToEmail });
    }
    return { saved: true, replyToEmail };
  },
};

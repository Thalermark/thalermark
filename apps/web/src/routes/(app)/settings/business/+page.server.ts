import { serverApiClient } from '$lib/api.server';
import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const companiesRes = await client.api.companies.$get();
  if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
  const { companies } = await companiesRes.json();

  // MVP single-company path, same first-company pick as the other settings tabs.
  const company = companies[0];
  if (!company) throw error(500, 'no company on this account');

  return { company };
};

export const actions: Actions = {
  // Saves the business address + phone shown on invoices. Empty inputs clear
  // the columns (API coerces '' → null → the public invoice drops that line).
  // Plain HTML form action, matching the rest of settings.
  save: async (event) => {
    const client = serverApiClient(event);
    const formData = await event.request.formData();
    const companyId = String(formData.get('companyId') ?? '');
    const businessAddress = String(formData.get('businessAddress') ?? '').trim();
    const businessPhone = String(formData.get('businessPhone') ?? '').trim();
    if (!companyId) return fail(400, { error: 'missing_company_id' });

    const res = await client.api.companies[':id'].$patch({
      param: { id: companyId },
      json: { businessAddress, businessPhone },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        error: body?.error ?? 'save_failed',
        businessAddress,
        businessPhone,
      });
    }
    return { saved: true, businessAddress, businessPhone };
  },
};

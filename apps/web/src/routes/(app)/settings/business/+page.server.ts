import { apiBaseUrl, serverApiClient, serverApiHeaders } from '$lib/api.server';
import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const companiesRes = await client.api.companies.$get();
  if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
  const { companies } = await companiesRes.json();

  // MVP single-company path, same first-company pick as the other settings tabs.
  const company = companies[0];
  if (!company) throw error(500, 'no company in this workspace');

  // Signed URL for the logo preview (same best-effort pattern as the expense
  // receipt). A 404 (no logo) or any failure simply renders the empty state.
  let logo: { url: string; contentType: string } | null = null;
  const logoRes = await client.api.companies[':id'].logo.$get({ param: { id: company.id } });
  if (logoRes.ok) logo = (await logoRes.json()) as { url: string; contentType: string };

  return { company, logo };
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

  // Forward the multipart logo to the api. Raw fetch (not the typed client),
  // same pattern as the expense receipt upload — FormData sets its own
  // content-type and serverApiHeaders carries the session + account.
  uploadLogo: async (event) => {
    const formData = await event.request.formData();
    const companyId = String(formData.get('companyId') ?? '');
    const file = formData.get('logo');
    if (!companyId) return fail(400, { logoError: 'missing_company_id' });
    if (!(file instanceof File) || file.size === 0) {
      return fail(400, { logoError: 'Choose an image to upload.' });
    }
    const fd = new FormData();
    fd.set('file', file);
    const res = await event.fetch(`${apiBaseUrl()}/api/companies/${companyId}/logo`, {
      method: 'POST',
      headers: serverApiHeaders(event),
      body: fd,
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      const code = body?.error ?? 'upload_failed';
      const msg =
        code === 'unsupported_media_type'
          ? 'Logo must be a PNG, JPEG, or WebP.'
          : code === 'file_too_large'
            ? 'Logo must be under 2 MB.'
            : code === 'storage_not_configured'
              ? 'Logo storage is not configured on this server.'
              : code;
      return fail(res.status, { logoError: msg });
    }
    redirect(303, '/settings/business');
  },

  removeLogo: async (event) => {
    const client = serverApiClient(event);
    const formData = await event.request.formData();
    const companyId = String(formData.get('companyId') ?? '');
    if (!companyId) return fail(400, { logoError: 'missing_company_id' });
    const res = await client.api.companies[':id'].logo.$delete({ param: { id: companyId } });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, { logoError: body?.error ?? 'remove_failed' });
    }
    redirect(303, '/settings/business');
  },
};

import { apiBaseUrl, serverApiClient, serverApiHeaders } from '$lib/api.server';
import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

// Step 3 — Make it yours. Optional logo, then the climax handoff into the first
// invoice. The company comes from the wizard layout; we only add the logo
// preview here so the earlier steps don't pay for the fetch.
export const load: PageServerLoad = async (event) => {
  const { company } = await event.parent();
  let logo: { url: string; contentType: string } | null = null;
  const client = serverApiClient(event);
  const logoRes = await client.api.companies[':id'].logo.$get({ param: { id: company.id } });
  if (logoRes.ok) logo = (await logoRes.json()) as { url: string; contentType: string };
  return { logo };
};

export const actions: Actions = {
  // Forward the multipart logo to the api (raw fetch, same pattern as
  // settings/business + the receipt upload). On success we stay on Step 3 so the
  // operator sees the logo land before the "send your first invoice" handoff.
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
    redirect(303, '/welcome/brand');
  },
};

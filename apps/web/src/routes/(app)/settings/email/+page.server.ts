import { pickActiveCompany } from '$lib/active-company';
import { serverApiClient } from '$lib/api.server';
import { error, fail } from '@sveltejs/kit';
import { EMAIL_TEMPLATE_TYPES, type EmailTemplateType } from '@thalermark/validation';
import type { Actions, PageServerLoad } from './$types';

function asType(t: string): EmailTemplateType | null {
  return (EMAIL_TEMPLATE_TYPES as readonly string[]).includes(t) ? (t as EmailTemplateType) : null;
}

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const companiesRes = await client.api.companies.$get();
  if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
  const { companies } = await companiesRes.json();

  // The active company within this workspace (cookie-backed switcher), same
  // pick as /settings/payments; falls back to the first for single-company.
  const company = pickActiveCompany(event.cookies, companies);
  if (!company) throw error(500, 'no company in this workspace');

  // The customizable email templates (effective copy + default/customized
  // state). The editor lives at /settings/email/[type]; this page just lists
  // them. A read — open to any role (the editor's writes stay gated).
  const tplRes = await client.api.companies[':id']['email-templates'].$get({
    param: { id: company.id },
  });
  const templates = tplRes.ok ? (await tplRes.json()).templates : [];

  return { company, templates };
};

export const actions: Actions = {
  // Render the EFFECTIVE template (saved override or default) as the contact
  // would see it, so a user can peek at the wording without entering the editor.
  // Re-renders through the same preview endpoint the editor uses (sample data),
  // off the stored subject/body — never client-supplied text.
  view: async (event) => {
    const client = serverApiClient(event);
    const formData = await event.request.formData();
    const companyId = String(formData.get('companyId') ?? '');
    const type = asType(String(formData.get('type') ?? ''));
    if (!companyId || !type) return fail(400, { viewType: null, viewError: 'invalid_request' });

    const tplRes = await client.api.companies[':id']['email-templates'].$get({
      param: { id: companyId },
    });
    if (!tplRes.ok) return fail(tplRes.status, { viewType: type, viewError: 'load_failed' });
    const tpl = (await tplRes.json()).templates.find((t) => t.type === type);
    if (!tpl) return fail(404, { viewType: type, viewError: 'not_found' });

    const res = await client.api.companies[':id']['email-templates'][':type'].preview.$post({
      param: { id: companyId, type },
      json: { subject: tpl.subject, body: tpl.body },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, { viewType: type, viewError: body?.error ?? 'preview_failed' });
    }
    const preview = await res.json();
    return { viewType: type, viewSubject: preview.subject, viewHtml: preview.html };
  },

  // Collapse the inline preview — the "View" button becomes "Close" while a row
  // is open. Just clears the view state (no preview in the returned form).
  close: async () => {
    return { viewType: null };
  },
};

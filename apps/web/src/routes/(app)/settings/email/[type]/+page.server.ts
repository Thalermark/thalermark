import { pickActiveCompany } from '$lib/active-company';
import { apiErrorMessage } from '$lib/api-errors';
import { serverApiClient } from '$lib/api.server';
import { error, fail, redirect } from '@sveltejs/kit';
import {
  EMAIL_TEMPLATE_TYPES,
  type EmailTemplateType,
  emailTemplateUpdateSchema,
  unknownPlaceholders,
} from '@thalermark/validation';
import type { Actions, PageServerLoad } from './$types';

function asType(t: string): EmailTemplateType | null {
  return (EMAIL_TEMPLATE_TYPES as readonly string[]).includes(t) ? (t as EmailTemplateType) : null;
}

export const load: PageServerLoad = async (event) => {
  const type = asType(event.params.type);
  if (!type) throw error(404, 'unknown template');

  const client = serverApiClient(event);
  const companiesRes = await client.api.companies.$get();
  if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
  const { companies } = await companiesRes.json();
  const company = pickActiveCompany(event.cookies, companies);
  if (!company) throw error(500, 'no company in this workspace');

  const tplRes = await client.api.companies[':id']['email-templates'].$get({
    param: { id: company.id },
  });
  if (!tplRes.ok) throw error(tplRes.status, 'failed to load templates');
  const { templates } = await tplRes.json();
  const template = templates.find((t) => t.type === type);
  if (!template) throw error(404, 'unknown template');

  return { company, type, template };
};

// Shared parse + placeholder check for the save/preview actions. Returns either
// a fail() payload (so the editor repopulates with an error) or the clean data.
function parseBody(type: EmailTemplateType, fd: FormData) {
  const subject = String(fd.get('subject') ?? '').trim();
  const body = String(fd.get('body') ?? '').trim();
  const companyId = String(fd.get('companyId') ?? '');
  const parsed = emailTemplateUpdateSchema.safeParse({ subject, body });
  if (!parsed.success) {
    return {
      fail: fail(400, { subject, body, error: parsed.error.issues[0]?.message ?? 'invalid' }),
    };
  }
  const bad = unknownPlaceholders(type, subject, body);
  if (bad.length) {
    return {
      fail: fail(400, {
        subject,
        body,
        error: `Unknown placeholder${bad.length > 1 ? 's' : ''}: ${bad.map((b) => `{{${b}}}`).join(', ')}`,
      }),
    };
  }
  return { data: parsed.data, companyId };
}

export const actions: Actions = {
  save: async (event) => {
    const type = asType(event.params.type);
    if (!type) return fail(404, { error: 'unknown template' });
    const client = serverApiClient(event);
    const parsed = parseBody(type, await event.request.formData());
    if (parsed.fail) return parsed.fail;

    const res = await client.api.companies[':id']['email-templates'][':type'].$put({
      param: { id: parsed.companyId, type },
      json: parsed.data,
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        ...parsed.data,
        error: apiErrorMessage(b?.error, 'That could not be saved. Try again.', b),
      });
    }
    // Re-run load so the Customized badge + stored values refresh.
    redirect(303, `/settings/email/${type}?saved=1`);
  },

  reset: async (event) => {
    const type = asType(event.params.type);
    if (!type) return fail(404, { error: 'unknown template' });
    const client = serverApiClient(event);
    const companyId = String((await event.request.formData()).get('companyId') ?? '');

    const res = await client.api.companies[':id']['email-templates'][':type'].$delete({
      param: { id: companyId, type },
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        error: apiErrorMessage(b?.error, 'That could not be reset. Try again.', b),
      });
    }
    redirect(303, `/settings/email/${type}?reset=1`);
  },

  preview: async (event) => {
    const type = asType(event.params.type);
    if (!type) return fail(404, { error: 'unknown template' });
    const client = serverApiClient(event);
    const parsed = parseBody(type, await event.request.formData());
    if (parsed.fail) return parsed.fail;

    const res = await client.api.companies[':id']['email-templates'][':type'].preview.$post({
      param: { id: parsed.companyId, type },
      json: parsed.data,
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        ...parsed.data,
        error: apiErrorMessage(b?.error, 'That preview could not be built. Try again.', b),
      });
    }
    const preview = await res.json();
    return { ...parsed.data, preview };
  },
};

import { pickActiveCompany } from '$lib/active-company';
import { apiErrorMessage } from '$lib/api-errors';
import { serverApiClient } from '$lib/api.server';
import { error, fail, redirect } from '@sveltejs/kit';
import { taxPolicyCreateSchema } from '@thalermark/validation';
import type { Actions } from './$types';

// ratePct is optional — a blank rate collapses to undefined so the percent
// regex doesn't trip; the API then defaults rate_pct to '0'. isDefault is a
// checkbox ('on' when checked).
function readForm(data: FormData): {
  name: string;
  ratePct?: string;
  isDefault: boolean;
} {
  const ratePctRaw = data.get('ratePct');
  return {
    name: String(data.get('name') ?? '').trim(),
    ratePct:
      typeof ratePctRaw === 'string' && ratePctRaw.trim() !== '' ? ratePctRaw.trim() : undefined,
    isDefault: data.get('isDefault') === 'on',
  };
}

export const actions: Actions = {
  default: async (event) => {
    const client = serverApiClient(event);
    const data = await event.request.formData();
    const values = readForm(data);

    const companiesRes = await client.api.companies.$get();
    // A lookup this action needs, not the thing the user asked for. Throwing
    // here renders the error page and discards the form, which is the very
    // loss TMC-248 is about — so it fails the action instead, keeping the
    // values on screen with a sentence saying why.
    if (!companiesRes.ok) {
      const body = (await companiesRes.json().catch(() => null)) as { error?: string } | null;
      return fail(companiesRes.status, {
        values,
        formError: apiErrorMessage(body?.error, 'That could not be saved. Try again.', body),
      });
    }
    const { companies } = await companiesRes.json();
    const first = pickActiveCompany(event.cookies, companies);
    if (!first) return fail(400, { values, formError: 'No company in this workspace.' });

    const parsed = taxPolicyCreateSchema.safeParse({ companyId: first.id, ...values });
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? '_');
        if (!fieldErrors[key]) fieldErrors[key] = issue.message;
      }
      return fail(400, { values, fieldErrors });
    }

    const res = await client.api['tax-policies'].$post({ json: parsed.data });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        values,
        formError: apiErrorMessage(body?.error, 'That could not be created. Try again.', body),
      });
    }
    const created = await res.json();
    redirect(303, `/settings/tax-policies/${created.id}`);
  },
};

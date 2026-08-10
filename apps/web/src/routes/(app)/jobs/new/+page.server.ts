import { pickActiveCompany } from '$lib/active-company';
import { apiErrorMessage } from '$lib/api-errors';
import { serverApiClient } from '$lib/api.server';
import { error, fail, redirect } from '@sveltejs/kit';
import { jobCreateSchema } from '@thalermark/validation';
import type { Actions, PageServerLoad } from './$types';

// Blank means "not set", not "fail the date regex" — a job with no customer and
// no dates is a perfectly good container, and most will start that way.
const OPTIONAL_FIELDS = ['contactId', 'startedOn', 'endedOn'] as const;

// Contacts for the optional customer picker, scoped to the active company.
export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const { activeCompanyId } = await event.parent();
  const query: Record<string, string> = { limit: '100' };
  if (activeCompanyId) query.companyId = activeCompanyId;
  const res = await client.api.contacts.$get({ query });
  const contacts = res.ok ? (await res.json()).contacts : [];
  return { contacts: contacts.map((c) => ({ id: c.id, name: c.name })) };
};

function readForm(data: FormData): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  out.name = String(data.get('name') ?? '').trim();
  for (const k of OPTIONAL_FIELDS) {
    const raw = data.get(k);
    if (typeof raw === 'string' && raw.trim() !== '') out[k] = raw.trim();
  }
  return out;
}

export const actions: Actions = {
  default: async (event) => {
    const client = serverApiClient(event);
    const data = await event.request.formData();
    const values = readForm(data);

    const companiesRes = await client.api.companies.$get();
    if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
    const { companies } = await companiesRes.json();
    const first = pickActiveCompany(event.cookies, companies);
    if (!first) return fail(400, { values, formError: 'No company in this workspace.' });

    const parsed = jobCreateSchema.safeParse({ companyId: first.id, ...values });
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        // The date-order refine has no path, so it lands on the form rather
        // than on a field — the message is about the pair, not either one.
        const key = String(issue.path[0] ?? '_');
        if (!fieldErrors[key]) fieldErrors[key] = issue.message;
      }
      return fail(400, { values, fieldErrors });
    }

    const res = await client.api.jobs.$post({ json: parsed.data });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        values,
        formError: apiErrorMessage(body?.error, 'That could not be created. Try again.', body),
      });
    }
    const created = await res.json();
    redirect(303, `/jobs/${created.id}`);
  },
};

import { pickActiveCompany } from '$lib/active-company';
import { serverApiClient } from '$lib/api.server';
import { findEmailDupe } from '$lib/contact-dupes';
import { error, fail, redirect } from '@sveltejs/kit';
import { contactCreateSchema } from '@thalermark/validation';
import type { Actions, PageServerLoad } from './$types';

// Load the contact list so the page can run live dupe-detection hints as
// the user types name/email. The action re-fetches the list to close the
// race where a dupe was created in another tab between load and submit.
export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  // Dupe hints are per-company (contacts belong to a company), so scope the
  // list to the active company (the nav switcher's pick).
  const { activeCompanyId } = await event.parent();
  const query: Record<string, string> = {};
  if (activeCompanyId) query.companyId = activeCompanyId;
  const res = await client.api.contacts.$get({ query });
  if (!res.ok) throw error(res.status, 'failed to load contacts');
  const { contacts } = await res.json();
  return {
    contacts: contacts.map((c) => ({ id: c.id, name: c.name, email: c.email ?? null })),
  };
};

// Optional string-field fields that should round-trip as undefined when the
// user leaves the input empty — empty strings would otherwise fail the zod
// `.email()` / `.max()` checks for inputs that the schema marks optional.
const OPTIONAL_FIELDS = [
  'email',
  'phone',
  'addressLine1',
  'addressLine2',
  'city',
  'region',
  'postalCode',
  'country',
  'notes',
] as const;

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

    // Auto-pick the only company for MVP single-company users. The multi-
    // company picker UX is deferred; the API still requires a companyId so
    // the server fills it in from /api/companies.
    const companiesRes = await client.api.companies.$get();
    if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
    const { companies } = await companiesRes.json();
    const first = pickActiveCompany(event.cookies, companies);
    if (!first) return fail(400, { values, formError: 'No company in this workspace.' });

    const parsed = contactCreateSchema.safeParse({ companyId: first.id, ...values });
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? '_');
        if (!fieldErrors[key]) fieldErrors[key] = issue.message;
      }
      return fail(400, { values, fieldErrors });
    }

    // Dupe-detect: HARD BLOCK on email exact match. Re-fetch the list to
    // close the race where another tab created the dupe between load() and
    // this POST. Name fuzzy match stays advisory and is handled client-side
    // only.
    const listRes = await client.api.contacts.$get({ query: { companyId: first.id } });
    if (listRes.ok) {
      const { contacts: list } = await listRes.json();
      const emailDupe = findEmailDupe(parsed.data.email, list);
      if (emailDupe) {
        return fail(409, {
          values,
          fieldErrors: { email: 'email_dupe' },
          dupeContact: { id: emailDupe.id, name: emailDupe.name },
        });
      }
    }

    const res = await client.api.contacts.$post({ json: parsed.data });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, { values, formError: body?.error ?? 'create_failed' });
    }
    const created = await res.json();
    redirect(303, `/contacts/${created.id}`);
  },
};

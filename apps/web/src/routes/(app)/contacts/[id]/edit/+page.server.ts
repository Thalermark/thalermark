import { apiErrorMessage } from '$lib/api-errors';
import { serverApiClient } from '$lib/api.server';
import { error, fail, redirect } from '@sveltejs/kit';
import { contactUpdateSchema } from '@thalermark/validation';
import type { Actions, PageServerLoad } from './$types';

// Same set as /contacts/new — optional fields whose empty string we collapse
// to undefined before zod parsing so .email() / .max() don't trip on a blank
// input the user left empty rather than cleared meaningfully. PATCH semantics
// then turn undefined into null in the API to clear the column.
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

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const res = await client.api.contacts[':id'].$get({ param: { id: event.params.id } });
  if (res.status === 404) throw error(404, 'contact not found');
  if (!res.ok) throw error(res.status, 'failed to load contact');
  const contact = await res.json();
  return { contact };
};

export const actions: Actions = {
  default: async (event) => {
    const client = serverApiClient(event);
    const data = await event.request.formData();
    const values = readForm(data);

    const parsed = contactUpdateSchema.safeParse(values);
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? '_');
        if (!fieldErrors[key]) fieldErrors[key] = issue.message;
      }
      return fail(400, { values, fieldErrors });
    }

    const res = await client.api.contacts[':id'].$patch({
      param: { id: event.params.id },
      json: parsed.data,
    });
    if (res.status === 404) throw error(404, 'contact not found');
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        values,
        formError: apiErrorMessage(body?.error, 'That could not be saved. Try again.', body),
      });
    }
    redirect(303, `/contacts/${event.params.id}`);
  },
};

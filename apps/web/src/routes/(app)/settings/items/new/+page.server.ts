import { serverApiClient } from '$lib/api.server';
import { error, fail, redirect } from '@sveltejs/kit';
import { itemCreateSchema } from '@thalermark/validation';
import type { Actions } from './$types';

// Optional fields whose empty string collapses to undefined before zod parsing
// — a blank unit price / quantity means "use the default", not "fail the
// money regex". The API then defaults unit_price to '0' and quantity to '1'.
const OPTIONAL_FIELDS = ['description', 'unitPrice', 'unitLabel', 'defaultQuantity'] as const;

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

    // Auto-pick the only company for MVP single-company users — same pattern
    // as /customers/new. The multi-company picker UX is deferred.
    const companiesRes = await client.api.companies.$get();
    if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
    const { companies } = await companiesRes.json();
    const first = companies[0];
    if (!first) return fail(400, { values, formError: 'No company on this account.' });

    const parsed = itemCreateSchema.safeParse({ companyId: first.id, ...values });
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? '_');
        if (!fieldErrors[key]) fieldErrors[key] = issue.message;
      }
      return fail(400, { values, fieldErrors });
    }

    const res = await client.api.items.$post({ json: parsed.data });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, { values, formError: body?.error ?? 'create_failed' });
    }
    const created = await res.json();
    redirect(303, `/settings/items/${created.id}`);
  },
};

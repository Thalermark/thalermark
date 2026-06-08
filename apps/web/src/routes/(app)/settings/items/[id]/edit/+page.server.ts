import { serverApiClient } from '$lib/api.server';
import { error, fail, redirect } from '@sveltejs/kit';
import { itemUpdateSchema } from '@thalermark/validation';
import type { Actions, PageServerLoad } from './$types';

// Same optional set as /settings/items/new — empty string collapses to
// undefined so the money/quantity regex doesn't trip on a blank input; the
// PATCH then resets the column to its default ('0' / '1' / null).
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

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const res = await client.api.items[':id'].$get({ param: { id: event.params.id } });
  if (res.status === 404) throw error(404, 'item not found');
  if (!res.ok) throw error(res.status, 'failed to load item');
  const item = await res.json();
  return { item };
};

export const actions: Actions = {
  default: async (event) => {
    const client = serverApiClient(event);
    const data = await event.request.formData();
    const values = readForm(data);

    const parsed = itemUpdateSchema.safeParse(values);
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? '_');
        if (!fieldErrors[key]) fieldErrors[key] = issue.message;
      }
      return fail(400, { values, fieldErrors });
    }

    const res = await client.api.items[':id'].$patch({
      param: { id: event.params.id },
      json: parsed.data,
    });
    if (res.status === 404) throw error(404, 'item not found');
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, { values, formError: body?.error ?? 'update_failed' });
    }
    redirect(303, `/settings/items/${event.params.id}`);
  },
};

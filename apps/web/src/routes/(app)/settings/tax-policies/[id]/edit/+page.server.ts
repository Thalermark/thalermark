import { apiErrorMessage } from '$lib/api-errors';
import { serverApiClient } from '$lib/api.server';
import { error, fail, redirect } from '@sveltejs/kit';
import { taxPolicyUpdateSchema } from '@thalermark/validation';
import type { Actions, PageServerLoad } from './$types';

// Same shape as /settings/tax-policies/new — a blank rate collapses to
// undefined (PATCH resets rate_pct to '0'); isDefault is a checkbox.
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

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const res = await client.api['tax-policies'][':id'].$get({ param: { id: event.params.id } });
  if (res.status === 404) throw error(404, 'tax policy not found');
  if (!res.ok) throw error(res.status, 'failed to load tax policy');
  const policy = await res.json();
  return { policy };
};

export const actions: Actions = {
  default: async (event) => {
    const client = serverApiClient(event);
    const data = await event.request.formData();
    const values = readForm(data);

    const parsed = taxPolicyUpdateSchema.safeParse(values);
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? '_');
        if (!fieldErrors[key]) fieldErrors[key] = issue.message;
      }
      return fail(400, { values, fieldErrors });
    }

    const res = await client.api['tax-policies'][':id'].$patch({
      param: { id: event.params.id },
      json: parsed.data,
    });
    if (res.status === 404) throw error(404, 'tax policy not found');
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        values,
        formError: apiErrorMessage(body?.error, 'That could not be saved. Try again.', body),
      });
    }
    redirect(303, `/settings/tax-policies/${event.params.id}`);
  },
};

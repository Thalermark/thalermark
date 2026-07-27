import { apiErrorMessage } from '$lib/api-errors';
import { serverApiClient } from '$lib/api.server';
import { error, fail, redirect } from '@sveltejs/kit';
import { ownerMoneyEventUpdateSchema } from '@thalermark/validation';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const res = await client.api['owner-money'][':id'].$get({ param: { id: event.params.id } });
  if (res.status === 404) throw error(404, 'not found');
  if (!res.ok) throw error(res.status, 'failed to load');
  return { event: await res.json() };
};

type FormValues = { kind: string; amount: string; occurredOn: string; memo: string };

function readForm(data: FormData): FormValues {
  return {
    kind: String(data.get('kind') ?? '').trim(),
    amount: String(data.get('amount') ?? '').trim(),
    occurredOn: String(data.get('occurredOn') ?? '').trim(),
    memo: String(data.get('memo') ?? '').trim(),
  };
}

export const actions: Actions = {
  save: async (event) => {
    const client = serverApiClient(event);
    const data = await event.request.formData();
    const values = readForm(data);

    // The edit form submits every field, so PATCH carries the full editable set.
    // memo is sent even when empty (so clearing it actually clears the column) —
    // the sparse update schema accepts an empty string.
    const parsed = ownerMoneyEventUpdateSchema.safeParse({
      kind: values.kind,
      amount: values.amount,
      occurredOn: values.occurredOn,
      memo: values.memo,
    });
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? '_');
        if (!fieldErrors[key]) fieldErrors[key] = issue.message;
      }
      return fail(400, { values, fieldErrors });
    }

    const res = await client.api['owner-money'][':id'].$patch({
      param: { id: event.params.id },
      json: parsed.data,
    });
    if (res.status === 404) throw error(404, 'not found');
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        values,
        formError: apiErrorMessage(body?.error, 'update_failed', body),
      });
    }
    redirect(303, `/owner-money/${event.params.id}`);
  },
};

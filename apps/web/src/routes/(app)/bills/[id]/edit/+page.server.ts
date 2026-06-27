import { serverApiClient } from '$lib/api.server';
import { error, fail, redirect } from '@sveltejs/kit';
import { billUpdateSchema } from '@thalermark/validation';
import type { Actions, PageServerLoad } from './$types';

type Account = { id: string; code: string; name: string };

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);

  const billRes = await client.api.bills[':id'].$get({ param: { id: event.params.id } });
  if (billRes.status === 404) throw error(404, 'bill not found');
  if (!billRes.ok) throw error(billRes.status, 'failed to load bill');
  const bill = await billRes.json();
  // Only open bills are editable — bounce paid/voided back to the detail page.
  if (bill.status !== 'open') redirect(303, `/bills/${event.params.id}`);

  const catRes = await client.api.companies[':id'].accounts.$get({
    param: { id: bill.companyId },
    query: { type: 'expense' },
  });
  if (!catRes.ok) throw error(catRes.status, 'failed to load categories');
  const categories = (await catRes.json()).accounts.map((a: Account) => ({
    id: a.id,
    label: `${a.code} · ${a.name}`,
  }));

  return { bill, categories };
};

export const actions: Actions = {
  default: async (event) => {
    const client = serverApiClient(event);
    const id = event.params.id;
    const data = await event.request.formData();
    const values = {
      contactId: String(data.get('contactId') ?? '').trim(),
      contactName: String(data.get('contactName') ?? '').trim(),
      categoryAccountId: String(data.get('categoryAccountId') ?? '').trim(),
      amount: String(data.get('amount') ?? '').trim(),
      billDate: String(data.get('billDate') ?? '').trim(),
      dueDate: String(data.get('dueDate') ?? '').trim(),
      reference: String(data.get('reference') ?? '').trim(),
      memo: String(data.get('memo') ?? '').trim(),
    };

    const parsed = billUpdateSchema.safeParse({
      contactId: values.contactId,
      categoryAccountId: values.categoryAccountId,
      amount: values.amount,
      billDate: values.billDate,
      dueDate: values.dueDate,
      reference: values.reference === '' ? undefined : values.reference,
      memo: values.memo === '' ? undefined : values.memo,
    });
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? '_');
        if (!fieldErrors[key]) fieldErrors[key] = issue.message;
      }
      return fail(400, { values, fieldErrors });
    }

    const res = await client.api.bills[':id'].$patch({ param: { id }, json: parsed.data });
    if (res.status === 404) throw error(404, 'bill not found');
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      const code = body?.error ?? 'update_failed';
      const msg =
        code === 'bill_not_editable'
          ? 'This bill can no longer be edited.'
          : code === 'invalid_category_account'
            ? 'That category is no longer a valid expense account.'
            : code;
      return fail(res.status, { values, formError: msg });
    }
    redirect(303, `/bills/${id}`);
  },
};

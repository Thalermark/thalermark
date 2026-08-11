import { pickActiveCompany } from '$lib/active-company';
import { apiErrorMessage } from '$lib/api-errors';
import { serverApiClient } from '$lib/api.server';
import { error, fail, redirect } from '@sveltejs/kit';
import { ownerMoneyEventCreateSchema } from '@thalermark/validation';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);

  const companiesRes = await client.api.companies.$get();
  if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
  const { companies } = await companiesRes.json();
  const company = pickActiveCompany(event.cookies, companies);
  if (!company) throw error(500, 'no company in this workspace');

  // Which account the money moves through (TMC-207). Bank accounts only: an
  // owner does not contribute money "into" a credit card, and a draw taken on
  // the business card is a card purchase, not a draw.
  const moneyRes = await client.api['money-accounts'].$get({ query: { companyId: company.id } });
  const moneyAccounts = moneyRes.ok
    ? (await moneyRes.json()).moneyAccounts.filter((a) => a.kind !== 'credit_card')
    : [];

  return { today: new Date().toISOString().slice(0, 10), moneyAccounts };
};

type FormValues = {
  kind: string;
  amount: string;
  occurredOn: string;
  memo: string;
  moneyAccountId: string;
};

function readForm(data: FormData): FormValues {
  return {
    kind: String(data.get('kind') ?? '').trim(),
    amount: String(data.get('amount') ?? '').trim(),
    occurredOn: String(data.get('occurredOn') ?? '').trim(),
    memo: String(data.get('memo') ?? '').trim(),
    moneyAccountId: String(data.get('moneyAccountId') ?? '').trim(),
  };
}

export const actions: Actions = {
  save: async (event) => {
    const client = serverApiClient(event);
    const data = await event.request.formData();
    const values = readForm(data);

    // companyId is resolved server-side (never trusted from the form) so a
    // crafted POST can't attach the event to another account's company.
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
    const companyId = pickActiveCompany(event.cookies, companies)?.id;
    if (!companyId) return fail(400, { values, formError: 'No company in this workspace.' });

    const parsed = ownerMoneyEventCreateSchema.safeParse({
      companyId,
      kind: values.kind,
      amount: values.amount,
      occurredOn: values.occurredOn,
      memo: values.memo === '' ? undefined : values.memo,
      // Absent → the server's primary account, which is where every event
      // recorded before there was a choice went.
      moneyAccountId: values.moneyAccountId === '' ? undefined : values.moneyAccountId,
    });
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? '_');
        if (!fieldErrors[key]) fieldErrors[key] = issue.message;
      }
      return fail(400, { values, fieldErrors });
    }

    const res = await client.api['owner-money'].$post({ json: parsed.data });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        values,
        formError: apiErrorMessage(body?.error, 'That could not be created. Try again.', body),
      });
    }
    const created = await res.json();
    redirect(303, `/owner-money/${created.id}`);
  },
};

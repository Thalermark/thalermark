import { pickActiveCompany } from '$lib/active-company';
import { serverApiClient } from '$lib/api.server';
import { error, fail, redirect } from '@sveltejs/kit';
import { manualJournalEntryCreateSchema } from '@thalermark/validation';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);

  const companiesRes = await client.api.companies.$get();
  if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
  const { companies } = await companiesRes.json();
  const company = pickActiveCompany(event.cookies, companies);
  if (!company) throw error(500, 'no company in this workspace');

  // Every active account — a manual entry can hit any account type (asset,
  // liability, equity, revenue, expense), unlike the expense/bill forms which
  // narrow to a category or a payment account.
  const accRes = await client.api.companies[':id'].accounts.$get({
    param: { id: company.id },
    // No type filter — a manual entry can hit any account type. (The route's
    // query validator types `type` as a required-but-optional-valued key, so we
    // pass it explicitly undefined; hc omits undefined params from the URL.)
    query: { type: undefined },
  });
  if (!accRes.ok) throw error(accRes.status, 'failed to load accounts');
  const { accounts } = await accRes.json();

  return {
    accounts: accounts.map((a) => ({
      id: a.id,
      code: a.code,
      name: a.name,
      accountType: a.accountType,
    })),
    today: new Date().toISOString().slice(0, 10),
  };
};

export const actions: Actions = {
  save: async (event) => {
    const client = serverApiClient(event);
    const data = await event.request.formData();
    const postedOn = String(data.get('postedOn') ?? '').trim();
    const memo = String(data.get('memo') ?? '').trim();
    // The dynamic lines are serialized to a hidden field by the client (a
    // variable-length list doesn't fit flat FormData fields cleanly).
    const linesRaw = String(data.get('lines') ?? '');
    const values = { postedOn, memo, linesRaw };

    let lines: unknown = [];
    try {
      lines = JSON.parse(linesRaw);
    } catch {
      return fail(400, { values, formError: 'Could not read the entry lines.' });
    }

    // companyId is resolved server-side (never trusted from the form) so a
    // crafted POST can't attach the entry to another account's company.
    const companiesRes = await client.api.companies.$get();
    if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
    const { companies } = await companiesRes.json();
    const companyId = pickActiveCompany(event.cookies, companies)?.id;
    if (!companyId) return fail(400, { values, formError: 'No company in this workspace.' });

    const parsed = manualJournalEntryCreateSchema.safeParse({ companyId, postedOn, memo, lines });
    if (!parsed.success) {
      // The client disables submit until the entry balances, so a failure here
      // is an edge case — surface the first issue's message.
      return fail(400, { values, formError: parsed.error.issues[0]?.message ?? 'Invalid entry.' });
    }

    const res = await client.api.ledger.entries.$post({ json: parsed.data });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      const message =
        body?.error === 'invalid_account'
          ? 'One of the accounts is not valid for this company.'
          : (body?.error ?? 'Could not post the entry.');
      return fail(res.status, { values, formError: message });
    }
    const created = await res.json();
    redirect(303, `/ledger/${created.id}`);
  },
};

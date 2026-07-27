import { pickActiveCompany } from '$lib/active-company';
import { apiErrorMessage } from '$lib/api-errors';
import { serverApiClient } from '$lib/api.server';
import { may } from '$lib/perms';
import { error, fail, redirect } from '@sveltejs/kit';
import { openingBalanceFullUpsertSchema, openingBalanceUpsertSchema } from '@thalermark/validation';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);

  const companiesRes = await client.api.companies.$get();
  if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
  const { companies } = await companiesRes.json();
  const company = pickActiveCompany(event.cookies, companies);
  if (!company) throw error(500, 'no company in this workspace');

  const res = await client.api['owner-money']['opening-balance'].$get({
    query: { companyId: company.id },
  });
  const body = res.ok ? await res.json() : null;
  const current = body?.openingBalance ?? null;
  const lines = body?.lines ?? [];

  // The chart, for the full trial balance. Only fetched for roles that can enter
  // one — it's ~30 accounts of payload the plain three-question path never reads.
  let accounts: { id: string; code: string; name: string; accountType: string }[] = [];
  if (may(event.locals.role, 'ledger:adjust')) {
    const accRes = await client.api.companies[':id'].accounts.$get({
      param: { id: company.id },
      query: { type: undefined },
    });
    if (accRes.ok) {
      accounts = (await accRes.json()).accounts.map((a) => ({
        id: a.id,
        code: a.code,
        name: a.name,
        accountType: a.accountType,
      }));
    }
  }

  return { current, lines, accounts, today: new Date().toISOString().slice(0, 10) };
};

type FormValues = { asOfDate: string; cash: string; receivables: string; payables: string };

function readForm(data: FormData): FormValues {
  return {
    asOfDate: String(data.get('asOfDate') ?? '').trim(),
    cash: String(data.get('cash') ?? '').trim(),
    receivables: String(data.get('receivables') ?? '').trim(),
    payables: String(data.get('payables') ?? '').trim(),
  };
}

export const actions: Actions = {
  save: async (event) => {
    const client = serverApiClient(event);
    const data = await event.request.formData();
    const values = readForm(data);

    // companyId is resolved server-side (never trusted from the form).
    const companiesRes = await client.api.companies.$get();
    if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
    const { companies } = await companiesRes.json();
    const companyId = pickActiveCompany(event.cookies, companies)?.id;
    if (!companyId) return fail(400, { values, formError: 'No company in this workspace.' });

    // Blank fields collapse to undefined so the schema applies its "0" default.
    const parsed = openingBalanceUpsertSchema.safeParse({
      companyId,
      asOfDate: values.asOfDate,
      cash: values.cash === '' ? undefined : values.cash,
      receivables: values.receivables === '' ? undefined : values.receivables,
      payables: values.payables === '' ? undefined : values.payables,
    });
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? '_');
        if (!fieldErrors[key]) fieldErrors[key] = issue.message;
      }
      return fail(400, { values, fieldErrors });
    }

    const res = await client.api['owner-money']['opening-balance'].$put({ json: parsed.data });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        values,
        formError: apiErrorMessage(body?.error, 'save_failed', body),
      });
    }
    redirect(303, '/owner-money');
  },

  // The full opening trial balance. A separate action rather than a mode flag on
  // `save`, so the plain three-question form keeps its exact shape and error
  // handling — the two paths only converge at the API.
  saveFull: async (event) => {
    const client = serverApiClient(event);
    const data = await event.request.formData();
    const asOfDate = String(data.get('asOfDate') ?? '').trim();
    // The variable-length line list is serialized to a hidden field by the
    // client, the same way the ledger portal's entry form does it.
    const linesRaw = String(data.get('lines') ?? '');

    const companiesRes = await client.api.companies.$get();
    if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
    const { companies } = await companiesRes.json();
    const companyId = pickActiveCompany(event.cookies, companies)?.id;
    if (!companyId) return fail(400, { fullError: 'No company in this workspace.' });

    let lines: unknown = [];
    try {
      lines = JSON.parse(linesRaw);
    } catch {
      return fail(400, { fullError: 'Could not read the opening balances.' });
    }

    const parsed = openingBalanceFullUpsertSchema.safeParse({ companyId, asOfDate, lines });
    if (!parsed.success) {
      // The client disables submit until it balances, so a failure here is an
      // edge case — surface the first issue's message rather than a field map.
      return fail(400, {
        fullError: parsed.error.issues[0]?.message ?? 'Invalid opening balances.',
      });
    }

    const res = await client.api['owner-money']['opening-balance'].$put({ json: parsed.data });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        fullError: apiErrorMessage(body?.error, 'Could not save these opening balances.', body),
      });
    }
    redirect(303, '/owner-money');
  },

  clear: async (event) => {
    const client = serverApiClient(event);
    const companiesRes = await client.api.companies.$get();
    if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
    const { companies } = await companiesRes.json();
    const companyId = pickActiveCompany(event.cookies, companies)?.id;
    if (!companyId) return fail(400, { formError: 'No company in this workspace.' });

    const res = await client.api['owner-money']['opening-balance'].$delete({
      query: { companyId },
    });
    if (!res.ok && res.status !== 404) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, { formError: apiErrorMessage(body?.error, 'clear_failed', body) });
    }
    redirect(303, '/owner-money');
  },
};

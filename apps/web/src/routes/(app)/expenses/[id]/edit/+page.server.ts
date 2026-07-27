import { apiErrorMessage } from '$lib/api-errors';
import { serverApiClient } from '$lib/api.server';
import { resolveVendorField } from '$lib/expense-vendor';
import { error, fail, redirect } from '@sveltejs/kit';
import { expenseUpdateSchema } from '@thalermark/validation';
import type { Actions, PageServerLoad } from './$types';

type Account = { id: string; code: string; name: string; accountType: string };

function accountOptions(accounts: Account[]) {
  return accounts.map((a) => ({ id: a.id, label: `${a.code} · ${a.name}` }));
}

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const expenseRes = await client.api.expenses[':id'].$get({ param: { id: event.params.id } });
  if (expenseRes.status === 404) throw error(404, 'expense not found');
  if (!expenseRes.ok) throw error(expenseRes.status, 'failed to load expense');
  const expense = await expenseRes.json();

  const [expenseAccRes, assetAccRes] = await Promise.all([
    client.api.companies[':id'].accounts.$get({
      param: { id: expense.companyId },
      query: { type: 'expense' },
    }),
    client.api.companies[':id'].accounts.$get({
      param: { id: expense.companyId },
      query: { type: 'asset' },
    }),
  ]);
  if (!expenseAccRes.ok) throw error(expenseAccRes.status, 'failed to load categories');
  if (!assetAccRes.ok) throw error(assetAccRes.status, 'failed to load payment accounts');
  const expenseAccounts = (await expenseAccRes.json()).accounts;
  const assetAccounts = (await assetAccRes.json()).accounts;

  // Receipt auto-fill (slice 8.9h) lands here via ?prefill=1 with the AI's
  // suggestions in the query. They seed the form (overriding the saved record)
  // but yield to a re-submitted value, so the user is always reviewing — never
  // an auto-applied edit. A suggested category id that's no longer a valid
  // option is dropped so the select doesn't open on a stale row.
  const sp = event.url.searchParams;
  const prefilled = sp.get('prefill') === '1';
  const prefill: Record<string, string> = {};
  if (prefilled) {
    const validCategory = new Set(expenseAccounts.map((a: Account) => a.id));
    for (const key of ['merchant', 'amount', 'expenseDate'] as const) {
      const val = sp.get(key);
      if (val) prefill[key] = val;
    }
    const cat = sp.get('categoryAccountId');
    if (cat && validCategory.has(cat)) prefill.categoryAccountId = cat;
  }

  return {
    expense,
    categories: accountOptions(expenseAccounts),
    paymentAccounts: accountOptions(assetAccounts),
    paymentPickerVisible: assetAccounts.length > 1,
    prefill,
    prefilled,
  };
};

type FormValues = {
  merchant: string;
  vendorContactId: string;
  amount: string;
  expenseDate: string;
  categoryAccountId: string;
  paymentAccountId: string;
  memo: string;
};

function readForm(data: FormData): FormValues {
  return {
    merchant: String(data.get('merchant') ?? '').trim(),
    // VendorPicker hidden field: '__unchanged__' | '' (unlink) | <uuid> | '__new__'.
    vendorContactId: String(data.get('vendorContactId') ?? '').trim(),
    amount: String(data.get('amount') ?? '').trim(),
    expenseDate: String(data.get('expenseDate') ?? '').trim(),
    categoryAccountId: String(data.get('categoryAccountId') ?? '').trim(),
    paymentAccountId: String(data.get('paymentAccountId') ?? '').trim(),
    memo: String(data.get('memo') ?? '').trim(),
  };
}

function formErrorFor(code: string): string {
  switch (code) {
    case 'invalid_category_account':
      return 'That category is no longer a valid expense account. Pick another.';
    case 'invalid_payment_account':
      return 'That payment account is no longer valid. Pick another.';
    default:
      return code;
  }
}

// A clean 2-dp decimal, so we only hand the categorizer an amount the API's
// money schema will accept (merchant alone is enough signal otherwise).
const CLEAN_AMOUNT = /^\d+(\.\d{1,2})?$/;

function suggestErrorFor(code: string): string {
  switch (code) {
    case 'ai_not_configured':
      return 'AI categorization is not configured on this server.';
    case 'categorization_failed':
      return 'Could not suggest a category. Pick the best fit by hand.';
    default:
      return code;
  }
}

export const actions: Actions = {
  // AI category suggestion from the typed fields. companyId comes from the
  // expense (an expense can't move companies). Re-renders with the suggested
  // category pre-selected and the user's edits preserved.
  suggest: async (event) => {
    const client = serverApiClient(event);
    const data = await event.request.formData();
    const values = readForm(data);
    if (values.merchant === '') {
      return fail(400, {
        values,
        suggestError: 'Enter a merchant first, then suggest a category.',
      });
    }

    const expenseRes = await client.api.expenses[':id'].$get({ param: { id: event.params.id } });
    if (expenseRes.status === 404) throw error(404, 'expense not found');
    if (!expenseRes.ok) throw error(expenseRes.status, 'failed to load expense');
    const companyId = (await expenseRes.json()).companyId;

    const res = await client.api.expenses.categorize.$post({
      json: {
        companyId,
        merchant: values.merchant,
        memo: values.memo === '' ? undefined : values.memo,
        amount: CLEAN_AMOUNT.test(values.amount) ? values.amount : undefined,
      },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, { values, suggestError: suggestErrorFor(body?.error ?? 'failed') });
    }
    const { suggestedCategoryAccountId } = await res.json();
    if (!suggestedCategoryAccountId) {
      return { values, suggestNotice: 'No category clearly fit — pick the best one.' };
    }
    return {
      values: { ...values, categoryAccountId: suggestedCategoryAccountId },
      suggested: true,
    };
  },

  save: async (event) => {
    const client = serverApiClient(event);
    const data = await event.request.formData();
    const values = readForm(data);

    // Load the company so an inline "+ Add vendor" creates the contact in the
    // right tenant scope (an expense can't move companies).
    const expRes = await client.api.expenses[':id'].$get({ param: { id: event.params.id } });
    if (expRes.status === 404) throw error(404, 'expense not found');
    if (!expRes.ok) throw error(expRes.status, 'failed to load expense');
    const companyId = (await expRes.json()).companyId;

    // Resolve the Vendor field. undefined → leave the link + needs-review flag
    // untouched (an unrelated edit must not resurrect a dismissed flag); null →
    // unlink; a uuid → (re)link. The API mirrors a linked name into merchant.
    const vendor = await resolveVendorField(
      client,
      companyId,
      values.vendorContactId,
      values.merchant,
    );
    if (!vendor.ok) {
      return fail(400, { values, formError: 'Could not add that vendor. Please try again.' });
    }

    // The edit form submits every field, so PATCH carries the full editable
    // set. memo is sent even when empty (so clearing it actually clears the
    // column) — the sparse update schema accepts an empty string.
    const parsed = expenseUpdateSchema.safeParse({
      vendorContactId: vendor.value,
      categoryAccountId: values.categoryAccountId,
      paymentAccountId: values.paymentAccountId,
      amount: values.amount,
      expenseDate: values.expenseDate,
      merchant: values.merchant,
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

    const res = await client.api.expenses[':id'].$patch({
      param: { id: event.params.id },
      json: parsed.data,
    });
    if (res.status === 404) throw error(404, 'expense not found');
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        values,
        formError: formErrorFor(apiErrorMessage(body?.error, 'update_failed', body)),
      });
    }
    redirect(303, `/expenses/${event.params.id}`);
  },
};

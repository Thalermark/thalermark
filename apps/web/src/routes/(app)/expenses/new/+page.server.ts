import { pickActiveCompany } from '$lib/active-company';
import { apiErrorMessage } from '$lib/api-errors';
import { serverApiClient } from '$lib/api.server';
import { resolveVendorField } from '$lib/expense-vendor';
import { error, fail, redirect } from '@sveltejs/kit';
import { expenseCreateSchema } from '@thalermark/validation';
import type { Actions, PageServerLoad } from './$types';

// Cash is the locked-default payment account (COA code 1000). The payment
// picker only surfaces once the company has a second asset account; until
// then every expense is "paid from Cash" and the field is a hidden input.
const CASH_CODE = '1000';

type Account = { id: string; code: string; name: string; accountType: string };

function accountOptions(accounts: Account[]) {
  return accounts.map((a) => ({ id: a.id, label: `${a.code} · ${a.name}` }));
}

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);

  const companiesRes = await client.api.companies.$get();
  if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
  const { companies } = await companiesRes.json();
  const company = pickActiveCompany(event.cookies, companies);
  if (!company) throw error(500, 'no company in this workspace');

  const [expenseRes, assetRes] = await Promise.all([
    client.api.companies[':id'].accounts.$get({
      param: { id: company.id },
      query: { type: 'expense' },
    }),
    client.api.companies[':id'].accounts.$get({
      param: { id: company.id },
      query: { type: 'asset' },
    }),
  ]);
  if (!expenseRes.ok) throw error(expenseRes.status, 'failed to load categories');
  if (!assetRes.ok) throw error(assetRes.status, 'failed to load payment accounts');
  const expenseAccounts = (await expenseRes.json()).accounts;
  const assetAccounts = (await assetRes.json()).accounts;

  const cash = assetAccounts.find((a) => a.code === CASH_CODE) ?? assetAccounts[0];

  // Duplicate-as-template: ?duplicate=<id> seeds the form from an existing
  // expense (merchant / amount / category / paid-from / memo). The DATE is not
  // copied — it defaults to today, since a duplicate is a fresh occurrence
  // (the recurring cell-phone / internet case). Best-effort: a missing or
  // cross-account source just yields an empty form. The user reviews + saves,
  // which runs the normal create + ledger posting — no server-side clone of a
  // posted expense.
  const duplicateId = event.url.searchParams.get('duplicate');
  let prefill: Record<string, string> = {};
  if (duplicateId) {
    const srcRes = await client.api.expenses[':id'].$get({ param: { id: duplicateId } });
    if (srcRes.ok) {
      const src = await srcRes.json();
      prefill = {
        merchant: src.merchant ?? '',
        // A duplicate of an expense paid to the same vendor keeps the link.
        vendorContactId: src.vendorContactId ?? '',
        amount: src.amount,
        categoryAccountId: src.categoryAccountId,
        paymentAccountId: src.paymentAccountId,
        memo: src.memo ?? '',
      };
    }
  }

  return {
    categories: accountOptions(expenseAccounts),
    paymentAccounts: accountOptions(assetAccounts),
    // Picker stays hidden while Cash is the only asset account.
    paymentPickerVisible: assetAccounts.length > 1,
    defaultPaymentId: cash?.id ?? '',
    today: new Date().toISOString().slice(0, 10),
    prefill,
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
    // The VendorPicker's hidden field: '' (unlinked) | <uuid> | '__new__'.
    vendorContactId: String(data.get('vendorContactId') ?? '').trim(),
    amount: String(data.get('amount') ?? '').trim(),
    expenseDate: String(data.get('expenseDate') ?? '').trim(),
    categoryAccountId: String(data.get('categoryAccountId') ?? '').trim(),
    paymentAccountId: String(data.get('paymentAccountId') ?? '').trim(),
    memo: String(data.get('memo') ?? '').trim(),
  };
}

// Map an API error code to a human banner. The COA-account codes are the only
// ones the user can realistically trigger from the form (a stale account that
// was deactivated between load and submit).
function formErrorFor(code: string): string {
  switch (code) {
    case 'invalid_category_account':
      return 'That category is no longer a valid expense account. Pick another.';
    case 'invalid_payment_account':
      return 'That payment account is no longer valid. Pick another.';
    case 'company_not_found':
      return 'No company in this workspace.';
    default:
      return code;
  }
}

// A clean 2-dp decimal, so we only hand the categorizer an amount the API's
// money schema will accept — a half-typed amount is dropped rather than 400ing
// the suggestion (merchant alone is enough signal).
const CLEAN_AMOUNT = /^\d+(\.\d{1,2})?$/;

// Map a categorize error code to a soft, non-blocking message. The suggestion
// is optional help — a failure never stops the user filling the form by hand.
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
  // AI category suggestion from the typed merchant (+ memo/amount). Re-renders
  // the form with the suggested category pre-selected and the user's typed
  // values preserved — the user reviews + saves; the AI never writes the
  // ledger. companyId is resolved server-side, same as create.
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

    const companiesRes = await client.api.companies.$get();
    if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
    const { companies } = await companiesRes.json();
    const companyId = pickActiveCompany(event.cookies, companies)?.id;
    if (!companyId) return fail(400, { values, formError: 'No company in this workspace.' });

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
    // Seed categoryAccountId via values so the select pre-selects it (the
    // svelte form reads form.values first); keep everything else the user typed.
    return {
      values: { ...values, categoryAccountId: suggestedCategoryAccountId },
      suggested: true,
    };
  },

  save: async (event) => {
    const client = serverApiClient(event);
    const data = await event.request.formData();
    const values = readForm(data);

    // companyId is resolved server-side (never trusted from the form) so a
    // crafted POST can't attach the expense to another account's company.
    const companiesRes = await client.api.companies.$get();
    if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
    const { companies } = await companiesRes.json();
    const companyId = pickActiveCompany(event.cookies, companies)?.id;
    if (!companyId) return fail(400, { values, formError: 'No company in this workspace.' });

    // Resolve the Vendor field: link an existing contact, create one inline, or
    // leave unlinked (free-text merchant). The API mirrors a linked contact's
    // name into merchant authoritatively.
    const vendor = await resolveVendorField(
      client,
      companyId,
      values.vendorContactId,
      values.merchant,
    );
    if (!vendor.ok) {
      return fail(400, { values, formError: 'Could not add that vendor. Please try again.' });
    }

    const parsed = expenseCreateSchema.safeParse({
      companyId,
      vendorContactId: vendor.value ?? undefined,
      categoryAccountId: values.categoryAccountId,
      paymentAccountId: values.paymentAccountId,
      amount: values.amount,
      expenseDate: values.expenseDate,
      merchant: values.merchant,
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

    const res = await client.api.expenses.$post({ json: parsed.data });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        values,
        formError: formErrorFor(apiErrorMessage(body?.error, 'create_failed', body)),
      });
    }
    const created = await res.json();
    redirect(303, `/expenses/${created.id}`);
  },
};

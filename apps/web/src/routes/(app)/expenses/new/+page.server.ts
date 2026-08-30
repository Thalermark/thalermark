import { pickActiveCompany } from '$lib/active-company';
import { apiErrorMessage } from '$lib/api-errors';
import { apiBaseUrl, apiFetch, serverApiClient, serverApiHeaders } from '$lib/api.server';
import { resolveVendorField } from '$lib/expense-vendor';
import { error, fail, redirect } from '@sveltejs/kit';
import { expenseCreateSchema } from '@thalermark/validation';
import type { Actions, PageServerLoad } from './$types';

// Cash is the locked-default payment account (COA code 1000). The payment
// picker only surfaces once the company has a second MONEY account; until then
// every expense is paid from the primary and the field is a hidden input.
const CASH_CODE = '1000';

type Account = { id: string; code: string; name: string; accountType: string };

// Name only, no numeric code — same reasoning as moneyOptions below, applied to
// the category field a dog groomer meets on their second screen. This dropdown
// used to read "6100 · Car & Truck Expenses" for ~24 options, which is the chart
// of accounts verbatim in the product whose promise is that the ledger stays
// hidden (TMC-222). The code is still the value; it is only the label that
// changed, so nothing downstream of the picker moves.
function accountOptions(accounts: Account[]) {
  return accounts.map((a) => ({ id: a.id, label: a.name }));
}

const KIND_LABEL: Record<string, string> = {
  checking: 'Checking',
  savings: 'Savings',
  cash: 'Cash',
  credit_card: 'Credit card',
};

// Paid-from options come from the money accounts, NOT from `type=asset`.
//
// That query returns Accounts Receivable, Vehicles & Equipment and Accumulated
// Depreciation as well as Cash, and this picker was offering all four — so
// "paid for fuel out of Accumulated Depreciation" was selectable, and posted a
// balanced entry that is nonsense (TMC-207). It also drops the numeric code
// from the label: the user picks the account they actually have, and the chart
// of accounts stays the system's business.
function moneyOptions(accounts: { id: string; name: string; kind: string | null }[]) {
  return accounts.map((a) => ({
    id: a.id,
    label: a.kind ? `${a.name} · ${KIND_LABEL[a.kind] ?? ''}` : a.name,
  }));
}

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);

  const companiesRes = await client.api.companies.$get();
  if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
  const { companies } = await companiesRes.json();
  const company = pickActiveCompany(event.cookies, companies);
  if (!company) throw error(500, 'no company in this workspace');

  const [expenseRes, moneyRes] = await Promise.all([
    client.api.companies[':id'].accounts.$get({
      param: { id: company.id },
      query: { type: 'expense' },
    }),
    client.api['money-accounts'].$get({ query: { companyId: company.id } }),
  ]);
  if (!expenseRes.ok) throw error(expenseRes.status, 'failed to load categories');
  if (!moneyRes.ok) throw error(moneyRes.status, 'failed to load payment accounts');
  const expenseAccounts = (await expenseRes.json()).accounts;
  const moneyAccounts = (await moneyRes.json()).moneyAccounts;

  const cash = moneyAccounts.find((a) => a.code === CASH_CODE) ?? moneyAccounts[0];

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

  // Best-effort AI probe for the chooser's "receipts won't be read" line
  // (TMC-295): true only when the server DEFINITELY has no AI connection. The
  // settings read is admin-gated (settings:manage), so a member's 403 leaves
  // this false and nothing is claimed either way — the extract attempt is the
  // authority, and its silent fallback covers everyone.
  let aiHint = false;
  try {
    const aiRes = await client.api.settings.ai.$get();
    if (aiRes.ok) aiHint = (await aiRes.json()).connection === null;
  } catch {}

  return {
    categories: accountOptions(expenseAccounts),
    paymentAccounts: moneyOptions(moneyAccounts),
    // Hidden while the seeded account is the only place money sits — asking
    // someone to pick from a list of one is noise.
    paymentPickerVisible: moneyAccounts.length > 1,
    defaultPaymentId: cash?.id ?? '',
    today: new Date().toISOString().slice(0, 10),
    prefill,
    aiHint,
    // A duplicate already answered "how do you want to log it?" — it seeds the
    // form from an existing expense, so the photo-first chooser is skipped.
    skipChooser: !!duplicateId,
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
// Returns undefined for anything it does not handle, so the caller falls
// through to the shared catalogue: `formErrorFor(x) ?? apiErrorMessage(x, …)`.
// This used to end in `default: return code`, which is how an unmapped code
// reached a user's screen (TMC-219). Route-specific copy still wins — it is
// just no longer the only thing standing between them and an identifier.
function formErrorFor(code: string | undefined): string | undefined {
  switch (code) {
    case 'invalid_category_account':
      return 'That category is no longer a valid expense account. Pick another.';
    case 'invalid_payment_account':
      return 'That payment account is no longer valid. Pick another.';
    case 'company_not_found':
      return 'No company in this workspace.';
    default:
      return undefined;
  }
}

// A clean 2-dp decimal, so we only hand the categorizer an amount the API's
// money schema will accept — a half-typed amount is dropped rather than 400ing
// the suggestion (merchant alone is enough signal).
const CLEAN_AMOUNT = /^\d+(\.\d{1,2})?$/;

// Map a categorize error code to a soft, non-blocking message. The suggestion
// is optional help — a failure never stops the user filling the form by hand.
// Returns undefined for anything it does not handle, so the caller falls
// through to the shared catalogue: `formErrorFor(x) ?? apiErrorMessage(x, …)`.
// This used to end in `default: return code`, which is how an unmapped code
// reached a user's screen (TMC-219). Route-specific copy still wins — it is
// just no longer the only thing standing between them and an identifier.
function suggestErrorFor(code: string | undefined): string | undefined {
  switch (code) {
    case 'ai_not_configured':
      return 'AI categorization is not configured on this server.';
    case 'categorization_failed':
      return 'Could not suggest a category. Pick the best fit by hand.';
    default:
      return undefined;
  }
}

// Photo-first fallback copy (TMC-295). Automatic and silent about blame: no
// dead end, no "try a clearer photo" as a wall. Whatever went wrong, the
// person still gets the form and the photo still saves with the expense.
const READ_FALLBACK_NOTICE =
  "Couldn't read the receipt this time. Fill it in below — the photo will still be saved.";
const AI_OFF_NOTICE =
  "Receipts aren't read automatically on this server — the photo will still be saved. Turn reading on in Settings → AI.";

export const actions: Actions = {
  // Photo-first receipt read (TMC-295 / TMC-235). Forwards the chosen file to
  // the stateless extract-receipt endpoint (nothing persists server-side — the
  // expense exists only when ?/save creates it) and re-renders the form
  // prefilled with whatever was read. A partial read is kept, not discarded;
  // every read failure lands on the same form with the photo still attached
  // (the file input keeps its FileList across the enhance update). Raw fetch
  // rather than the typed client because the hc client has no typed `form`
  // surface for multipart, same as the detail page's uploadReceipt.
  extract: async (event) => {
    const data = await event.request.formData();
    const values = readForm(data);
    const file = data.get('file');
    if (!(file instanceof File) || file.size === 0) {
      return fail(400, { values, receiptError: 'Choose a photo or PDF of the receipt.' });
    }

    const client = serverApiClient(event);
    const companiesRes = await client.api.companies.$get();
    if (!companiesRes.ok) {
      return { values, receiptNotice: READ_FALLBACK_NOTICE };
    }
    const { companies } = await companiesRes.json();
    const companyId = pickActiveCompany(event.cookies, companies)?.id;
    if (!companyId) return fail(400, { values, formError: 'No company in this workspace.' });

    const fd = new FormData();
    fd.set('companyId', companyId);
    fd.set('file', file);
    let res: Response;
    try {
      res = await apiFetch(
        `${apiBaseUrl()}/api/expenses/extract-receipt`,
        { method: 'POST', headers: serverApiHeaders(event), body: fd },
        event.fetch,
      );
    } catch {
      return { values, receiptNotice: READ_FALLBACK_NOTICE };
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      // A rejected FILE is a real error — a photo the server refuses to read
      // is one it will refuse to save too, so the flow cannot continue with it.
      if (body?.error === 'unsupported_media_type') {
        return fail(415, { values, receiptError: 'Receipts must be a JPEG, PNG, or PDF.' });
      }
      if (body?.error === 'file_too_large') {
        return fail(413, { values, receiptError: 'Receipt must be under 10 MB.' });
      }
      // Everything else falls back without blame: manual form, photo kept.
      return {
        values,
        receiptNotice: body?.error === 'ai_not_configured' ? AI_OFF_NOTICE : READ_FALLBACK_NOTICE,
      };
    }

    const out = (await res.json()) as {
      extraction: { merchant: string | null; total: string | null; expenseDate: string | null };
      suggestedCategoryAccountId: string | null;
    };
    const prefilled = { ...values };
    if (out.extraction.merchant) prefilled.merchant = out.extraction.merchant;
    if (out.extraction.total) prefilled.amount = out.extraction.total;
    if (out.extraction.expenseDate) prefilled.expenseDate = out.extraction.expenseDate;
    if (out.suggestedCategoryAccountId) {
      prefilled.categoryAccountId = out.suggestedCategoryAccountId;
    }
    const readAnything =
      out.extraction.merchant ||
      out.extraction.total ||
      out.extraction.expenseDate ||
      out.suggestedCategoryAccountId;
    if (!readAnything) return { values, receiptNotice: READ_FALLBACK_NOTICE };
    const full = out.extraction.merchant && out.extraction.total && out.extraction.expenseDate;
    return { values: prefilled, extracted: full ? ('full' as const) : ('partial' as const) };
  },

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
      return fail(res.status, {
        values,
        suggestError:
          suggestErrorFor(body?.error) ??
          apiErrorMessage(body?.error, 'No suggestion right now — pick a category by hand.'),
      });
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

    // Photo-first (TMC-295): with a receipt riding the form, the ONE save goes
    // to the multipart create-with-receipt endpoint — both-or-neither on the
    // server, so a failed upload never yields an expense that claims a receipt
    // it does not have. Without one, the plain JSON create as before.
    const file = data.get('file');
    if (file instanceof File && file.size > 0) {
      const fd = new FormData();
      for (const [key, value] of Object.entries(parsed.data)) {
        if (value != null) fd.set(key, value);
      }
      fd.set('file', file);
      const res = await apiFetch(
        `${apiBaseUrl()}/api/expenses/with-receipt`,
        { method: 'POST', headers: serverApiHeaders(event), body: fd },
        event.fetch,
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        const msg =
          body?.error === 'unsupported_media_type'
            ? 'Receipts must be a JPEG, PNG, or PDF.'
            : body?.error === 'file_too_large'
              ? 'Receipt must be under 10 MB.'
              : body?.error === 'storage_not_configured'
                ? 'Receipt storage is not configured on this server.'
                : (formErrorFor(body?.error) ??
                  apiErrorMessage(body?.error, 'That could not be created. Try again.', body));
        return fail(res.status, { values, formError: msg });
      }
      const created = (await res.json()) as { id: string };
      redirect(303, `/expenses/${created.id}`);
    }

    const res = await client.api.expenses.$post({ json: parsed.data });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        values,
        formError:
          formErrorFor(body?.error) ??
          apiErrorMessage(body?.error, 'That could not be created. Try again.', body),
      });
    }
    const created = await res.json();
    redirect(303, `/expenses/${created.id}`);
  },
};

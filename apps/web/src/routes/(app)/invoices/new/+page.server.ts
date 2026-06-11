import { serverApiClient } from '$lib/api.server';
import { findEmailDupe } from '$lib/customer-dupes';
import { error, fail, redirect } from '@sveltejs/kit';
import {
  type InvoiceCreateInput,
  type InvoiceLineItemInput,
  addMoney,
  customerCreateSchema,
  invoiceCreateSchema,
  multiplyMoney,
  sumMoney,
} from '@thalermark/validation';
import type { Actions, PageServerLoad } from './$types';

// Sentinel customerId value emitted by the "+ Add new customer" option in
// the invoice form's dropdown. The action branches on it: instead of
// treating the value as a UUID, it pulls the inline name + email fields
// and creates the customer first, then uses the returned id for the
// invoice POST. Mirrors the literal in +page.svelte.
const NEW_CUSTOMER_SENTINEL = '__new__';

// Line item field names on the form. Each is a multi-value input (one per
// row); the server zips them by index. Matches the names emitted by
// +page.svelte's {#each rows} block.
const LINE_FIELD_DESCRIPTION = 'li_description';
const LINE_FIELD_QUANTITY = 'li_quantity';
const LINE_FIELD_UNIT_PRICE = 'li_unitPrice';
const LINE_FIELD_SOURCE_ITEM_ID = 'li_sourceItemId';

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const [companiesRes, customersRes] = await Promise.all([
    client.api.companies.$get(),
    client.api.customers.$get(),
  ]);
  if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
  if (!customersRes.ok) throw error(customersRes.status, 'failed to load customers');
  const { companies } = await companiesRes.json();
  const { customers } = await customersRes.json();
  const company = companies[0];
  if (!company) throw error(500, 'no company in this workspace');

  // Suggestion fetch is best-effort: a transient failure shouldn't block the
  // page from rendering. The user can always type their own number, and the
  // 8.4c fail-re-render path uses values?.number ?? data.suggestedNumber, so
  // an empty suggestion just means an empty field.
  let suggestedNumber = '';
  const suggestRes = await client.api.invoices['next-number'].$get({
    query: { companyId: company.id },
  });
  if (suggestRes.ok) {
    const body = (await suggestRes.json()) as { suggestion: string };
    suggestedNumber = body.suggestion;
  }

  return {
    companyId: company.id,
    suggestedNumber,
    // email is loaded alongside name so the dupe-detection helper (8.6b)
    // can match against it client-side without an extra round-trip. The
    // dropdown render only uses {id, name}; the rest is opaque to the UI.
    customers: customers
      .map((c) => ({ id: c.id, name: c.name, email: c.email ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
};

type FormValues = {
  customerId: string;
  newCustomerName: string;
  newCustomerEmail: string;
  number: string;
  issueDate: string;
  dueDate: string;
  notes: string;
  tax: string;
  lineItems: {
    description: string;
    quantity: string;
    unitPrice: string;
    sourceItemId?: string;
  }[];
};

function readForm(data: FormData): FormValues {
  const descriptions = data.getAll(LINE_FIELD_DESCRIPTION).map((v) => String(v));
  const quantities = data.getAll(LINE_FIELD_QUANTITY).map((v) => String(v));
  const unitPrices = data.getAll(LINE_FIELD_UNIT_PRICE).map((v) => String(v));
  const sourceItemIds = data.getAll(LINE_FIELD_SOURCE_ITEM_ID).map((v) => String(v));
  const rowCount = Math.max(descriptions.length, quantities.length, unitPrices.length);
  const lineItems = Array.from({ length: rowCount }, (_, i) => ({
    description: (descriptions[i] ?? '').trim(),
    quantity: (quantities[i] ?? '').trim(),
    unitPrice: (unitPrices[i] ?? '').trim(),
    // Empty hidden input (hand-typed line) → undefined, so the schema's
    // optional uuid passes and the column stays null.
    sourceItemId: (sourceItemIds[i] ?? '').trim() || undefined,
  }));
  return {
    customerId: String(data.get('customerId') ?? '').trim(),
    newCustomerName: String(data.get('newCustomerName') ?? '').trim(),
    newCustomerEmail: String(data.get('newCustomerEmail') ?? '').trim(),
    number: String(data.get('number') ?? '').trim(),
    issueDate: String(data.get('issueDate') ?? '').trim(),
    dueDate: String(data.get('dueDate') ?? '').trim(),
    notes: String(data.get('notes') ?? '').trim(),
    tax: String(data.get('tax') ?? '').trim(),
    lineItems,
  };
}

export const actions: Actions = {
  default: async (event) => {
    const client = serverApiClient(event);
    const data = await event.request.formData();
    const values = readForm(data);
    const companyId = (await loadCompanyId(event)) ?? '';

    // Inline-create branch: validate the customer fields, POST /api/customers,
    // and swap the returned UUID into `customerId` before continuing to the
    // invoice POST. Schema reuses customerCreateSchema (same shape as the
    // standalone /customers/new form, just with fewer fields surfaced).
    // On failure, render the form back in new-mode with field errors —
    // values.customerId stays as the sentinel so the inline block re-opens.
    let resolvedCustomerId = values.customerId;
    let extraCustomer: { id: string; name: string } | undefined;
    if (values.customerId === NEW_CUSTOMER_SENTINEL) {
      const customerInput = {
        companyId,
        name: values.newCustomerName,
        email: values.newCustomerEmail === '' ? undefined : values.newCustomerEmail,
      };
      const parsedCust = customerCreateSchema.safeParse(customerInput);
      if (!parsedCust.success) {
        const customerErrors: Record<string, string> = {};
        for (const issue of parsedCust.error.issues) {
          const key = String(issue.path[0] ?? '_');
          if (!customerErrors[key]) customerErrors[key] = issue.message;
        }
        return fail(400, { values, customerErrors });
      }

      // Dupe-detect: HARD BLOCK on email exact match. Re-fetch the list
      // server-side to close the race where another tab created the dupe
      // between load() and this POST. Name fuzzy match stays advisory and
      // is handled client-side only (live hint, no submit block).
      const listRes = await client.api.customers.$get();
      if (listRes.ok) {
        const { customers: list } = await listRes.json();
        const emailDupe = findEmailDupe(parsedCust.data.email, list);
        if (emailDupe) {
          return fail(409, {
            values,
            customerErrors: { email: 'email_dupe' },
            dupeCustomer: { id: emailDupe.id, name: emailDupe.name },
          });
        }
      }

      const custRes = await client.api.customers.$post({ json: parsedCust.data });
      if (!custRes.ok) {
        const body = (await custRes.json().catch(() => null)) as { error?: string } | null;
        return fail(custRes.status, {
          values,
          customerErrors: { _: body?.error ?? 'customer_create_failed' },
        });
      }
      const createdCustomer = await custRes.json();
      resolvedCustomerId = createdCustomer.id;
      extraCustomer = { id: createdCustomer.id, name: createdCustomer.name };
    }

    // Server is authority for money math — same helpers the page uses for
    // live preview, so the form works without JS (zero-row totals still
    // compute). Schema validation runs against these computed values.
    const computedLines: InvoiceLineItemInput[] = values.lineItems.map((row, i) => ({
      position: i + 1,
      description: row.description,
      quantity: row.quantity,
      unitPrice: row.unitPrice,
      amount: multiplyMoney(row.quantity, row.unitPrice),
      sourceItemId: row.sourceItemId,
    }));
    const subtotal = sumMoney(computedLines.map((li) => li.amount));
    const tax = values.tax === '' ? undefined : values.tax;
    const total = addMoney(subtotal, tax ?? '0');

    const payload: InvoiceCreateInput = {
      companyId,
      customerId: resolvedCustomerId,
      number: values.number,
      issueDate: values.issueDate,
      dueDate: values.dueDate,
      subtotal,
      tax,
      total,
      notes: values.notes === '' ? undefined : values.notes,
      lineItems: computedLines,
    };

    const parsed = invoiceCreateSchema.safeParse(payload);
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const top = String(issue.path[0] ?? '_');
        // Line-item errors collapse onto `lineItems` so the form can render
        // one inline notice without addressing each row+field combination.
        const key = top === 'lineItems' ? 'lineItems' : top;
        if (!fieldErrors[key]) fieldErrors[key] = issue.message;
      }
      // If we got here via the inline-create branch, the customer was already
      // persisted — swap the sentinel for the real id so the re-render
      // pre-selects them and surfaces extraCustomer in the dropdown.
      return fail(400, {
        values: extraCustomer ? { ...values, customerId: extraCustomer.id } : values,
        fieldErrors,
        extraCustomer,
      });
    }

    const res = await client.api.invoices.$post({ json: parsed.data });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      const code = body?.error ?? 'create_failed';
      const formError =
        code === 'invoice_number_taken'
          ? 'Invoice number already used for this company. Try another.'
          : code === 'customer_company_mismatch'
            ? 'Selected customer does not belong to this company.'
            : code === 'customer_not_found'
              ? 'Selected customer no longer exists.'
              : code;
      // Same recovery as schema fail above: if a customer was just created,
      // pre-select them on the re-render so the user doesn't lose them or
      // accidentally duplicate via a second sentinel pick.
      return fail(res.status, {
        values: extraCustomer ? { ...values, customerId: extraCustomer.id } : values,
        formError,
        extraCustomer,
      });
    }
    const created = await res.json();
    redirect(303, `/invoices/${created.id}`);
  },
};

// load() already fetched the companyId, but the action runs in a separate
// request lifecycle and doesn't have access to load's return. Re-fetching
// keeps the action self-contained (no cookie-stuffed hidden field that a
// crafted POST could swap for another account's company).
async function loadCompanyId(event: Parameters<Actions['default']>[0]) {
  const client = serverApiClient(event);
  const res = await client.api.companies.$get();
  if (!res.ok) return null;
  const { companies } = await res.json();
  return companies[0]?.id;
}

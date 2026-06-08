import { serverApiClient } from '$lib/api.server';
import { error, fail, redirect } from '@sveltejs/kit';
import {
  type EstimateCreateInput,
  type EstimateLineItemInput,
  addMoney,
  estimateCreateSchema,
  multiplyMoney,
  sumMoney,
} from '@thalermark/validation';
import type { Actions, PageServerLoad } from './$types';

// Line item field names on the form — multi-value inputs, zipped by index
// on the server. Matches the names emitted by +page.svelte's {#each rows}.
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
  if (!company) throw error(500, 'no company on this account');

  // Suggestion fetch is best-effort: the user can type their own number,
  // and the fail-re-render path uses values?.number ?? data.suggestedNumber.
  let suggestedNumber = '';
  const suggestRes = await client.api.estimates['next-number'].$get({
    query: { companyId: company.id },
  });
  if (suggestRes.ok) {
    const body = (await suggestRes.json()) as { suggestion: string };
    suggestedNumber = body.suggestion;
  }

  return {
    companyId: company.id,
    suggestedNumber,
    customers: customers
      .map((c) => ({ id: c.id, name: c.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
};

type FormValues = {
  customerId: string;
  number: string;
  issueDate: string;
  expiresOn: string;
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
    sourceItemId: (sourceItemIds[i] ?? '').trim() || undefined,
  }));
  return {
    customerId: String(data.get('customerId') ?? '').trim(),
    number: String(data.get('number') ?? '').trim(),
    issueDate: String(data.get('issueDate') ?? '').trim(),
    expiresOn: String(data.get('expiresOn') ?? '').trim(),
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

    // Server is authority for money math — same helpers the page uses for
    // live preview, so the form works without JS and the live preview
    // can't drift from what's stored.
    const computedLines: EstimateLineItemInput[] = values.lineItems.map((row, i) => ({
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

    const payload: EstimateCreateInput = {
      companyId,
      customerId: values.customerId,
      number: values.number,
      issueDate: values.issueDate,
      expiresOn: values.expiresOn === '' ? undefined : values.expiresOn,
      subtotal,
      tax,
      total,
      notes: values.notes === '' ? undefined : values.notes,
      lineItems: computedLines,
    };

    const parsed = estimateCreateSchema.safeParse(payload);
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const top = String(issue.path[0] ?? '_');
        const key = top === 'lineItems' ? 'lineItems' : top;
        if (!fieldErrors[key]) fieldErrors[key] = issue.message;
      }
      return fail(400, { values, fieldErrors });
    }

    const res = await client.api.estimates.$post({ json: parsed.data });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      const code = body?.error ?? 'create_failed';
      const formError =
        code === 'estimate_number_taken'
          ? 'Estimate number already used for this company. Try another.'
          : code === 'customer_company_mismatch'
            ? 'Selected customer does not belong to this company.'
            : code === 'customer_not_found'
              ? 'Selected customer no longer exists.'
              : code;
      return fail(res.status, { values, formError });
    }
    const created = await res.json();
    redirect(303, `/estimates/${created.id}`);
  },
};

// load() already fetched the companyId, but the action runs in a separate
// request lifecycle. Re-fetching keeps the action self-contained — no
// hidden field that a crafted POST could swap for another account's id.
async function loadCompanyId(event: Parameters<Actions['default']>[0]) {
  const client = serverApiClient(event);
  const res = await client.api.companies.$get();
  if (!res.ok) return null;
  const { companies } = await res.json();
  return companies[0]?.id;
}

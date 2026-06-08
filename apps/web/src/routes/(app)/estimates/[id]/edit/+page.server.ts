import { serverApiClient } from '$lib/api.server';
import { error, fail, redirect } from '@sveltejs/kit';
import {
  type EstimateLineItemInput,
  type EstimateUpdateInput,
  addMoney,
  estimateUpdateSchema,
  multiplyMoney,
  sumMoney,
} from '@thalermark/validation';
import type { Actions, PageServerLoad } from './$types';

// Multi-value field names; zipped on the server. Matches /estimates/new.
const LINE_FIELD_DESCRIPTION = 'li_description';
const LINE_FIELD_QUANTITY = 'li_quantity';
const LINE_FIELD_UNIT_PRICE = 'li_unitPrice';
const LINE_FIELD_SOURCE_ITEM_ID = 'li_sourceItemId';

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const [estimateRes, customersRes] = await Promise.all([
    client.api.estimates[':id'].$get({ param: { id: event.params.id } }),
    client.api.customers.$get(),
  ]);
  if (estimateRes.status === 404) throw error(404, 'estimate not found');
  if (!estimateRes.ok) throw error(estimateRes.status, 'failed to load estimate');
  if (!customersRes.ok) throw error(customersRes.status, 'failed to load customers');
  const estimate = await estimateRes.json();
  // Edit is draft-only on the API side — surface the same boundary at load
  // so a stale tab landing on /edit after a status flip gets a clean 409
  // rather than a confusing post-submit 409.
  if (estimate.status !== 'draft') {
    throw error(409, 'this estimate is no longer editable');
  }
  const { customers } = await customersRes.json();
  return {
    estimate,
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

    const payload: EstimateUpdateInput = {
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

    const parsed = estimateUpdateSchema.safeParse(payload);
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const top = String(issue.path[0] ?? '_');
        const key = top === 'lineItems' ? 'lineItems' : top;
        if (!fieldErrors[key]) fieldErrors[key] = issue.message;
      }
      return fail(400, { values, fieldErrors });
    }

    const res = await client.api.estimates[':id'].$patch({
      param: { id: event.params.id },
      json: parsed.data,
    });
    if (res.status === 404) throw error(404, 'estimate not found');
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      const code = body?.error ?? 'update_failed';
      const formError =
        code === 'estimate_number_taken'
          ? 'Estimate number already used for this company. Try another.'
          : code === 'customer_company_mismatch'
            ? 'Selected customer does not belong to this company.'
            : code === 'customer_not_found'
              ? 'Selected customer no longer exists.'
              : code === 'not_editable'
                ? 'This estimate is no longer in draft and cannot be edited.'
                : code;
      return fail(res.status, { values, formError });
    }
    redirect(303, `/estimates/${event.params.id}`);
  },
};

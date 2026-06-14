import { serverApiClient } from '$lib/api.server';
import { error, fail, redirect } from '@sveltejs/kit';
import {
  type InvoiceLineItemInput,
  type InvoiceUpdateInput,
  addMoney,
  invoiceUpdateSchema,
  multiplyMoney,
  sumMoney,
} from '@thalermark/validation';
import type { Actions, PageServerLoad } from './$types';

// Field names mirror /invoices/new — multi-value inputs zipped by index.
const LINE_FIELD_DESCRIPTION = 'li_description';
const LINE_FIELD_QUANTITY = 'li_quantity';
const LINE_FIELD_UNIT_PRICE = 'li_unitPrice';
const LINE_FIELD_SOURCE_ITEM_ID = 'li_sourceItemId';

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  // Scope the customer dropdown to the active company (the nav switcher's pick).
  const { activeCompanyId } = await event.parent();
  const custQuery: Record<string, string> = {};
  if (activeCompanyId) custQuery.companyId = activeCompanyId;
  const [invoiceRes, customersRes] = await Promise.all([
    client.api.invoices[':id'].$get({ param: { id: event.params.id } }),
    client.api.customers.$get({ query: custQuery }),
  ]);
  if (invoiceRes.status === 404) throw error(404, 'invoice not found');
  if (!invoiceRes.ok) throw error(invoiceRes.status, 'failed to load invoice');
  if (!customersRes.ok) throw error(customersRes.status, 'failed to load customers');
  const invoice = await invoiceRes.json();
  // Edit is draft-only on the API side — surface the same boundary here so
  // a stale tab that lands on /edit after a status flip gets a clean 404
  // rather than a confusing 409 on submit.
  if (invoice.status !== 'draft') {
    throw error(409, 'this invoice is no longer editable');
  }
  const { customers } = await customersRes.json();
  return {
    invoice,
    customers: customers
      .map((c) => ({ id: c.id, name: c.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
};

type FormValues = {
  customerId: string;
  number: string;
  issueDate: string;
  dueDate: string;
  notes: string;
  tax: string;
  showAddress: boolean;
  showPhone: boolean;
  showEmail: boolean;
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
    dueDate: String(data.get('dueDate') ?? '').trim(),
    notes: String(data.get('notes') ?? '').trim(),
    tax: String(data.get('tax') ?? '').trim(),
    // Unchecked boxes don't submit, so absence = false. The form always renders
    // all three, so each round-trips as an explicit boolean.
    showAddress: data.get('showAddress') === 'on',
    showPhone: data.get('showPhone') === 'on',
    showEmail: data.get('showEmail') === 'on',
    lineItems,
  };
}

export const actions: Actions = {
  default: async (event) => {
    const client = serverApiClient(event);
    const data = await event.request.formData();
    const values = readForm(data);

    // Mirrors /invoices/new — server recomputes totals so the form works
    // without JS and the live preview can't drift from what's stored.
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

    const payload: InvoiceUpdateInput = {
      customerId: values.customerId,
      number: values.number,
      issueDate: values.issueDate,
      dueDate: values.dueDate,
      subtotal,
      tax,
      total,
      notes: values.notes === '' ? undefined : values.notes,
      showAddress: values.showAddress,
      showPhone: values.showPhone,
      showEmail: values.showEmail,
      lineItems: computedLines,
    };

    const parsed = invoiceUpdateSchema.safeParse(payload);
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const top = String(issue.path[0] ?? '_');
        const key = top === 'lineItems' ? 'lineItems' : top;
        if (!fieldErrors[key]) fieldErrors[key] = issue.message;
      }
      return fail(400, { values, fieldErrors });
    }

    const res = await client.api.invoices[':id'].$patch({
      param: { id: event.params.id },
      json: parsed.data,
    });
    if (res.status === 404) throw error(404, 'invoice not found');
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      const code = body?.error ?? 'update_failed';
      const formError =
        code === 'invoice_number_taken'
          ? 'Invoice number already used for this company. Try another.'
          : code === 'customer_company_mismatch'
            ? 'Selected customer does not belong to this company.'
            : code === 'customer_not_found'
              ? 'Selected customer no longer exists.'
              : code === 'not_editable'
                ? 'This invoice is no longer in draft and cannot be edited.'
                : code;
      return fail(res.status, { values, formError });
    }
    redirect(303, `/invoices/${event.params.id}`);
  },
};

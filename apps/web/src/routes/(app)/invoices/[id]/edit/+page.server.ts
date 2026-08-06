import { apiErrorMessage } from '$lib/api-errors';
import { serverApiClient } from '$lib/api.server';
import { lineTax, policyRate } from '$lib/line-tax';
import { error, fail, redirect } from '@sveltejs/kit';
import {
  type InvoiceLineItemInput,
  type InvoiceUpdateInput,
  type LineItemType,
  addMoney,
  hoursFromMinutes,
  invoiceUpdateSchema,
  multiplyMoney,
  sumMoney,
} from '@thalermark/validation';
import type { Actions, PageServerLoad } from './$types';

// Field names mirror /invoices/new — multi-value inputs zipped by index.
const LINE_FIELD_DESCRIPTION = 'li_description';
const LINE_FIELD_QUANTITY = 'li_quantity';
// Free-text unit of measure; one value per row so getAll() stays index-aligned.
const LINE_FIELD_UNIT_LABEL = 'li_unitLabel';
const LINE_FIELD_UNIT_PRICE = 'li_unitPrice';
const LINE_FIELD_SOURCE_ITEM_ID = 'li_sourceItemId';
// Product/service <select> — one value per row, always submitted.
const LINE_FIELD_TYPE = 'li_type';
const LINE_FIELD_TIME_ENTRY_ID = 'li_timeEntryId';
const LINE_FIELD_TAXABLE = 'li_taxable';
const LINE_FIELD_TAX_POLICY_ID = 'li_taxPolicyId';

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const invoiceRes = await client.api.invoices[':id'].$get({ param: { id: event.params.id } });
  if (invoiceRes.status === 404) throw error(404, 'invoice not found');
  if (!invoiceRes.ok) throw error(invoiceRes.status, 'failed to load invoice');
  const invoice = await invoiceRes.json();
  // Edit is draft-only on the API side — surface the same boundary here so
  // a stale tab that lands on /edit after a status flip gets a clean 404
  // rather than a confusing 409 on submit.
  if (invoice.status !== 'draft') {
    throw error(409, 'this invoice is no longer editable');
  }

  // The contact selector is a type-ahead (ContactPicker, allowCreate=false)
  // that searches /contacts/search on demand, so we only need the currently
  // linked contact's name to seed the field — not the whole list.
  let initialContact: { id: string; name: string } | null = null;
  const contactRes = await client.api.contacts[':id'].$get({
    param: { id: invoice.contactId },
  });
  if (contactRes.ok) {
    const c = await contactRes.json();
    initialContact = { id: c.id, name: c.name };
  }

  // Active tax policies for the per-line tax picker (scoped to the invoice's
  // company). A line already tied to an archived policy still renders its rate
  // because the line carries the snapshot — the picker just won't re-offer it.
  const polRes = await client.api['tax-policies'].$get({
    query: { companyId: invoice.companyId, limit: '100' },
  });
  const taxPolicies = polRes.ok ? (await polRes.json()).taxPolicies : [];

  // Unbilled hours on this invoice's job (TMC-180), so a draft can absorb time
  // logged AFTER it was started. Without this, "Continue INV-0005" leads to the
  // one screen that cannot bill the hours the job screen is advertising as
  // ready — which is exactly the dead end the draft guard routes people into.
  //
  // Entries already billed to THIS invoice no longer need carrying separately:
  // since 0027 each line stores its own timeEntryId, so the rows rebuild the set
  // on their own and deleting a line releases its entry.
  let unbilledTime: {
    id: string;
    entryDate: string;
    minutes: number;
    hours: string;
    note: string | null;
    rate: string | null;
  }[] = [];
  if (invoice.jobId) {
    const timeRes = await client.api.jobs[':id'].time.$get({
      param: { id: invoice.jobId },
      query: { unbilled: undefined },
    });
    if (timeRes.ok) {
      const { timeEntries } = await timeRes.json();
      unbilledTime = timeEntries
        .filter((t) => t.billedInvoiceId === null)
        .map((t) => ({
          id: t.id,
          entryDate: t.entryDate,
          minutes: t.minutes,
          hours: hoursFromMinutes(t.minutes),
          note: t.note,
          rate: t.rate,
        }));
    }
  }

  return {
    invoice,
    initialContact,
    unbilledTime,
    taxPolicies: taxPolicies.map((p) => ({
      id: p.id,
      name: p.name,
      ratePct: p.ratePct,
      isDefault: p.isDefault,
    })),
  };
};

type FormValues = {
  contactId: string;
  // Round-trips the ContactPicker's visible search text so a fail() re-render
  // re-shows the selected contact name (read but not sent to the API).
  contactName: string;
  number: string;
  issueDate: string;
  dueDate: string;
  notes: string;
  showAddress: boolean;
  showPhone: boolean;
  showEmail: boolean;
  lineItems: {
    description: string;
    quantity: string;
    unitLabel?: string;
    unitPrice: string;
    sourceItemId?: string;
    type?: LineItemType;
    taxable: boolean;
    taxPolicyId?: string;
    timeEntryId?: string;
  }[];
};

function readForm(data: FormData): FormValues {
  const descriptions = data.getAll(LINE_FIELD_DESCRIPTION).map((v) => String(v));
  const quantities = data.getAll(LINE_FIELD_QUANTITY).map((v) => String(v));
  const unitLabels = data.getAll(LINE_FIELD_UNIT_LABEL).map((v) => String(v));
  const unitPrices = data.getAll(LINE_FIELD_UNIT_PRICE).map((v) => String(v));
  const sourceItemIds = data.getAll(LINE_FIELD_SOURCE_ITEM_ID).map((v) => String(v));
  const types = data.getAll(LINE_FIELD_TYPE).map((v) => String(v));
  const timeEntryIds = data.getAll(LINE_FIELD_TIME_ENTRY_ID).map((v) => String(v));
  const taxables = data.getAll(LINE_FIELD_TAXABLE).map((v) => String(v));
  const taxPolicyIds = data.getAll(LINE_FIELD_TAX_POLICY_ID).map((v) => String(v));
  const rowCount = Math.max(descriptions.length, quantities.length, unitPrices.length);
  const lineItems = Array.from({ length: rowCount }, (_, i): FormValues['lineItems'][number] => ({
    description: (descriptions[i] ?? '').trim(),
    quantity: (quantities[i] ?? '').trim(),
    unitLabel: (unitLabels[i] ?? '').trim() || undefined,
    unitPrice: (unitPrices[i] ?? '').trim(),
    sourceItemId: (sourceItemIds[i] ?? '').trim() || undefined,
    // Garbage / missing → undefined so the API defaults the line to 'service'.
    type: types[i] === 'product' ? 'product' : types[i] === 'service' ? 'service' : undefined,
    taxable: (taxables[i] ?? '0') === '1',
    taxPolicyId: (taxPolicyIds[i] ?? '').trim() || undefined,
    timeEntryId: (timeEntryIds[i] ?? '').trim() || undefined,
  }));
  return {
    contactId: String(data.get('contactId') ?? '').trim(),
    contactName: String(data.get('contactName') ?? '').trim(),
    number: String(data.get('number') ?? '').trim(),
    issueDate: String(data.get('issueDate') ?? '').trim(),
    dueDate: String(data.get('dueDate') ?? '').trim(),
    notes: String(data.get('notes') ?? '').trim(),
    // Unchecked boxes don't submit, so absence = false. The form always renders
    // all three, so each round-trips as an explicit boolean.
    showAddress: data.get('showAddress') === 'on',
    showPhone: data.get('showPhone') === 'on',
    showEmail: data.get('showEmail') === 'on',
    lineItems,
  };
}

// Policy id → rate map for the authoritative line-tax recompute. includeArchived
// so a line referencing a just-archived policy still resolves its snapshot rate.
async function loadPolicyRates(
  event: Parameters<Actions['default']>[0],
  companyId: string,
): Promise<{ id: string; ratePct: string }[]> {
  if (!companyId) return [];
  const client = serverApiClient(event);
  const res = await client.api['tax-policies'].$get({
    query: { companyId, includeArchived: 'true', limit: '500' },
  });
  if (!res.ok) return [];
  const { taxPolicies } = await res.json();
  return taxPolicies.map((p) => ({ id: p.id, ratePct: p.ratePct }));
}

export const actions: Actions = {
  default: async (event) => {
    const client = serverApiClient(event);
    const data = await event.request.formData();
    const values = readForm(data);

    // Mirrors /invoices/new — server recomputes totals so the form works
    // without JS and the live preview can't drift from what's stored. The line
    // tax rate is resolved from the policy (not trusted from the client) and the
    // invoice tax is the derived sum of line tax. Resolve the invoice's company
    // first so the policy lookup is correctly scoped.
    const curRes = await client.api.invoices[':id'].$get({ param: { id: event.params.id } });
    const companyId = curRes.ok ? (await curRes.json()).companyId : '';
    const policies = await loadPolicyRates(event, companyId);
    const computedLines: InvoiceLineItemInput[] = values.lineItems.map((row, i) => {
      const amount = multiplyMoney(row.quantity, row.unitPrice);
      const rate = row.taxable ? policyRate(policies, row.taxPolicyId ?? '') : '0';
      return {
        position: i + 1,
        description: row.description,
        quantity: row.quantity,
        unitLabel: row.unitLabel,
        unitPrice: row.unitPrice,
        amount,
        type: row.type,
        taxable: row.taxable,
        taxRatePct: rate,
        taxAmount: lineTax(row.taxable, rate, amount),
        taxPolicyId: row.taxable ? row.taxPolicyId : undefined,
        sourceItemId: row.sourceItemId,
      };
    });
    const subtotal = sumMoney(computedLines.map((li) => li.amount));
    const tax = sumMoney(computedLines.map((li) => li.taxAmount ?? '0'));
    const total = addMoney(subtotal, tax);

    const payload: InvoiceUpdateInput = {
      contactId: values.contactId,
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
      const code = apiErrorMessage(body?.error, 'update_failed', body);
      const formError =
        code === 'invoice_number_taken'
          ? 'Invoice number already used for this company. Try another.'
          : code === 'customer_company_mismatch'
            ? 'Selected contact does not belong to this company.'
            : code === 'contact_not_found'
              ? 'Selected contact no longer exists.'
              : code === 'not_editable'
                ? 'This invoice is no longer in draft and cannot be edited.'
                : code;
      return fail(res.status, { values, formError });
    }
    redirect(303, `/invoices/${event.params.id}`);
  },
};

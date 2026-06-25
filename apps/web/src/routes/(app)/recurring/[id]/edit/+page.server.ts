import { serverApiClient } from '$lib/api.server';
import { lineTax, policyRate } from '$lib/line-tax';
import { error, fail, redirect } from '@sveltejs/kit';
import {
  type LineItemType,
  type RecurringInvoiceLineItemInput,
  type RecurringInvoiceUpdateInput,
  addMoney,
  multiplyMoney,
  recurringInvoiceUpdateSchema,
  sumMoney,
} from '@thalermark/validation';
import type { Actions, PageServerLoad } from './$types';

const LINE_FIELD_DESCRIPTION = 'li_description';
const LINE_FIELD_QUANTITY = 'li_quantity';
const LINE_FIELD_UNIT_PRICE = 'li_unitPrice';
const LINE_FIELD_SOURCE_ITEM_ID = 'li_sourceItemId';
// Product/service <select> — one value per row, always submitted.
const LINE_FIELD_TYPE = 'li_type';
const LINE_FIELD_TAXABLE = 'li_taxable';
const LINE_FIELD_TAX_POLICY_ID = 'li_taxPolicyId';

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const scheduleRes = await client.api['recurring-invoices'][':id'].$get({
    param: { id: event.params.id },
  });
  if (scheduleRes.status === 404) throw error(404, 'recurring schedule not found');
  if (!scheduleRes.ok) throw error(scheduleRes.status, 'failed to load recurring schedule');
  const schedule = await scheduleRes.json();
  // Edit is blocked once ended (terminal) on the API side — surface the same
  // boundary at load so a stale tab gets a clean 409, not a post-submit one.
  if (schedule.status === 'ended') {
    throw error(409, 'this schedule has ended and can no longer be edited');
  }

  // The contact selector is a type-ahead (ContactPicker, allowCreate=false)
  // that searches /contacts/search on demand, so we only need the currently
  // linked contact's name to seed the field — not the whole list.
  let initialContact: { id: string; name: string } | null = null;
  const contactRes = await client.api.contacts[':id'].$get({
    param: { id: schedule.contactId },
  });
  if (contactRes.ok) {
    const c = await contactRes.json();
    initialContact = { id: c.id, name: c.name };
  }

  const polRes = await client.api['tax-policies'].$get({
    query: { companyId: schedule.companyId, limit: '100' },
  });
  const taxPolicies = polRes.ok ? (await polRes.json()).taxPolicies : [];

  return {
    schedule,
    initialContact,
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
  frequency: string;
  intervalCount: string;
  startDate: string;
  endDate: string;
  maxOccurrences: string;
  netTermsDays: string;
  notes: string;
  lineItems: {
    description: string;
    quantity: string;
    unitPrice: string;
    sourceItemId?: string;
    type?: LineItemType;
    taxable: boolean;
    taxPolicyId?: string;
  }[];
};

function readForm(data: FormData): FormValues {
  const descriptions = data.getAll(LINE_FIELD_DESCRIPTION).map((v) => String(v));
  const quantities = data.getAll(LINE_FIELD_QUANTITY).map((v) => String(v));
  const unitPrices = data.getAll(LINE_FIELD_UNIT_PRICE).map((v) => String(v));
  const sourceItemIds = data.getAll(LINE_FIELD_SOURCE_ITEM_ID).map((v) => String(v));
  const types = data.getAll(LINE_FIELD_TYPE).map((v) => String(v));
  const taxables = data.getAll(LINE_FIELD_TAXABLE).map((v) => String(v));
  const taxPolicyIds = data.getAll(LINE_FIELD_TAX_POLICY_ID).map((v) => String(v));
  const rowCount = Math.max(descriptions.length, quantities.length, unitPrices.length);
  const lineItems = Array.from({ length: rowCount }, (_, i): FormValues['lineItems'][number] => ({
    description: (descriptions[i] ?? '').trim(),
    quantity: (quantities[i] ?? '').trim(),
    unitPrice: (unitPrices[i] ?? '').trim(),
    sourceItemId: (sourceItemIds[i] ?? '').trim() || undefined,
    // Garbage / missing → undefined so the API defaults the line to 'service'.
    type: types[i] === 'product' ? 'product' : types[i] === 'service' ? 'service' : undefined,
    taxable: (taxables[i] ?? '0') === '1',
    taxPolicyId: (taxPolicyIds[i] ?? '').trim() || undefined,
  }));
  return {
    contactId: String(data.get('contactId') ?? '').trim(),
    contactName: String(data.get('contactName') ?? '').trim(),
    frequency: String(data.get('frequency') ?? '').trim(),
    intervalCount: String(data.get('intervalCount') ?? '').trim(),
    startDate: String(data.get('startDate') ?? '').trim(),
    endDate: String(data.get('endDate') ?? '').trim(),
    maxOccurrences: String(data.get('maxOccurrences') ?? '').trim(),
    netTermsDays: String(data.get('netTermsDays') ?? '').trim(),
    notes: String(data.get('notes') ?? '').trim(),
    lineItems,
  };
}

function toNumber(raw: string): number | undefined {
  if (raw === '') return undefined;
  return Number(raw);
}

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

    const curRes = await client.api['recurring-invoices'][':id'].$get({
      param: { id: event.params.id },
    });
    const companyId = curRes.ok ? (await curRes.json()).companyId : '';
    const policies = await loadPolicyRates(event, companyId);
    const computedLines: RecurringInvoiceLineItemInput[] = values.lineItems.map((row, i) => {
      const amount = multiplyMoney(row.quantity, row.unitPrice);
      const rate = row.taxable ? policyRate(policies, row.taxPolicyId ?? '') : '0';
      return {
        position: i + 1,
        description: row.description,
        quantity: row.quantity,
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

    const payload: RecurringInvoiceUpdateInput = {
      contactId: values.contactId,
      frequency: values.frequency as RecurringInvoiceUpdateInput['frequency'],
      intervalCount: toNumber(values.intervalCount) ?? 1,
      startDate: values.startDate,
      endDate: values.endDate === '' ? undefined : values.endDate,
      maxOccurrences: toNumber(values.maxOccurrences),
      netTermsDays: toNumber(values.netTermsDays),
      subtotal,
      tax,
      total,
      notes: values.notes === '' ? undefined : values.notes,
      lineItems: computedLines,
    };

    const parsed = recurringInvoiceUpdateSchema.safeParse(payload);
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const top = String(issue.path[0] ?? '_');
        const key = top === 'lineItems' ? 'lineItems' : top;
        if (!fieldErrors[key]) fieldErrors[key] = issue.message;
      }
      return fail(400, { values, fieldErrors });
    }

    const res = await client.api['recurring-invoices'][':id'].$patch({
      param: { id: event.params.id },
      json: parsed.data,
    });
    if (res.status === 404) throw error(404, 'recurring schedule not found');
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      const code = body?.error ?? 'update_failed';
      const formError =
        code === 'customer_company_mismatch'
          ? 'Selected contact does not belong to this company.'
          : code === 'contact_not_found'
            ? 'Selected contact no longer exists.'
            : code === 'not_editable'
              ? 'This schedule has ended and cannot be edited.'
              : code;
      return fail(res.status, { values, formError });
    }
    redirect(303, `/recurring/${event.params.id}`);
  },
};

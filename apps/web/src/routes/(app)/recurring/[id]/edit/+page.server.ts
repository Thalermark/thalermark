import { serverApiClient } from '$lib/api.server';
import { error, fail, redirect } from '@sveltejs/kit';
import {
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

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  // Scope the customer dropdown to the active company (the nav switcher's pick).
  const { activeCompanyId } = await event.parent();
  const custQuery: Record<string, string> = {};
  if (activeCompanyId) custQuery.companyId = activeCompanyId;
  const [scheduleRes, customersRes] = await Promise.all([
    client.api['recurring-invoices'][':id'].$get({ param: { id: event.params.id } }),
    client.api.customers.$get({ query: custQuery }),
  ]);
  if (scheduleRes.status === 404) throw error(404, 'recurring schedule not found');
  if (!scheduleRes.ok) throw error(scheduleRes.status, 'failed to load recurring schedule');
  if (!customersRes.ok) throw error(customersRes.status, 'failed to load customers');
  const schedule = await scheduleRes.json();
  // Edit is blocked once ended (terminal) on the API side — surface the same
  // boundary at load so a stale tab gets a clean 409, not a post-submit one.
  if (schedule.status === 'ended') {
    throw error(409, 'this schedule has ended and can no longer be edited');
  }
  const { customers } = await customersRes.json();
  return {
    schedule,
    customers: customers
      .map((c) => ({ id: c.id, name: c.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
};

type FormValues = {
  customerId: string;
  frequency: string;
  intervalCount: string;
  startDate: string;
  endDate: string;
  maxOccurrences: string;
  netTermsDays: string;
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
    frequency: String(data.get('frequency') ?? '').trim(),
    intervalCount: String(data.get('intervalCount') ?? '').trim(),
    startDate: String(data.get('startDate') ?? '').trim(),
    endDate: String(data.get('endDate') ?? '').trim(),
    maxOccurrences: String(data.get('maxOccurrences') ?? '').trim(),
    netTermsDays: String(data.get('netTermsDays') ?? '').trim(),
    notes: String(data.get('notes') ?? '').trim(),
    tax: String(data.get('tax') ?? '').trim(),
    lineItems,
  };
}

function toNumber(raw: string): number | undefined {
  if (raw === '') return undefined;
  return Number(raw);
}

export const actions: Actions = {
  default: async (event) => {
    const client = serverApiClient(event);
    const data = await event.request.formData();
    const values = readForm(data);

    const computedLines: RecurringInvoiceLineItemInput[] = values.lineItems.map((row, i) => ({
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

    const payload: RecurringInvoiceUpdateInput = {
      customerId: values.customerId,
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
          ? 'Selected customer does not belong to this company.'
          : code === 'customer_not_found'
            ? 'Selected customer no longer exists.'
            : code === 'not_editable'
              ? 'This schedule has ended and cannot be edited.'
              : code;
      return fail(res.status, { values, formError });
    }
    redirect(303, `/recurring/${event.params.id}`);
  },
};

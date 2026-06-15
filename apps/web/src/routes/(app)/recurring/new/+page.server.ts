import { pickActiveCompany } from '$lib/active-company';
import { serverApiClient } from '$lib/api.server';
import { lineTax, policyRate } from '$lib/line-tax';
import { error, fail, redirect } from '@sveltejs/kit';
import {
  type LineItemType,
  type RecurringInvoiceCreateInput,
  type RecurringInvoiceLineItemInput,
  addMoney,
  multiplyMoney,
  recurringInvoiceCreateSchema,
  sumMoney,
} from '@thalermark/validation';
import type { Actions, PageServerLoad } from './$types';

// Multi-value line-item field names, zipped by index on the server. Same shape
// as /invoices/new and /estimates/new.
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
  // Scope the customer dropdown to the active company (the nav switcher's pick).
  const { activeCompanyId } = await event.parent();
  const custQuery: Record<string, string> = {};
  if (activeCompanyId) custQuery.companyId = activeCompanyId;
  const [companiesRes, customersRes] = await Promise.all([
    client.api.companies.$get(),
    client.api.customers.$get({ query: custQuery }),
  ]);
  if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
  if (!customersRes.ok) throw error(customersRes.status, 'failed to load customers');
  const { companies } = await companiesRes.json();
  const { customers } = await customersRes.json();
  const company = pickActiveCompany(event.cookies, companies);
  if (!company) throw error(500, 'no company in this workspace');

  const polRes = await client.api['tax-policies'].$get({
    query: { companyId: company.id, limit: '100' },
  });
  const taxPolicies = polRes.ok ? (await polRes.json()).taxPolicies : [];

  return {
    companyId: company.id,
    customers: customers
      .map((c) => ({ id: c.id, name: c.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    taxPolicies: taxPolicies.map((p) => ({
      id: p.id,
      name: p.name,
      ratePct: p.ratePct,
      isDefault: p.isDefault,
    })),
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
    customerId: String(data.get('customerId') ?? '').trim(),
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

// Numeric fields cross the API as JSON numbers (unlike money, which is decimal
// strings). Empty → undefined so the server applies its defaults; otherwise
// Number() — NaN flows through to the schema, which rejects it with a field
// error rather than silently coercing.
function toNumber(raw: string): number | undefined {
  if (raw === '') return undefined;
  return Number(raw);
}

export const actions: Actions = {
  default: async (event) => {
    const client = serverApiClient(event);
    const data = await event.request.formData();
    const values = readForm(data);
    const companyId = (await loadCompanyId(event)) ?? '';

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

    const payload: RecurringInvoiceCreateInput = {
      companyId,
      customerId: values.customerId,
      frequency: values.frequency as RecurringInvoiceCreateInput['frequency'],
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

    const parsed = recurringInvoiceCreateSchema.safeParse(payload);
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const top = String(issue.path[0] ?? '_');
        const key = top === 'lineItems' ? 'lineItems' : top;
        if (!fieldErrors[key]) fieldErrors[key] = issue.message;
      }
      return fail(400, { values, fieldErrors });
    }

    const res = await client.api['recurring-invoices'].$post({ json: parsed.data });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      const code = body?.error ?? 'create_failed';
      const formError =
        code === 'customer_company_mismatch'
          ? 'Selected customer does not belong to this company.'
          : code === 'customer_not_found'
            ? 'Selected customer no longer exists.'
            : code;
      return fail(res.status, { values, formError });
    }
    const created = await res.json();
    redirect(303, `/recurring/${created.id}`);
  },
};

// Re-fetch in the action so the company id isn't a hidden field a crafted POST
// could swap for another account's. Same pattern as /estimates/new.
async function loadCompanyId(event: Parameters<Actions['default']>[0]) {
  const client = serverApiClient(event);
  const res = await client.api.companies.$get();
  if (!res.ok) return null;
  const { companies } = await res.json();
  return pickActiveCompany(event.cookies, companies)?.id;
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

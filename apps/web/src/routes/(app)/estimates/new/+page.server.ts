import { pickActiveCompany } from '$lib/active-company';
import { serverApiClient } from '$lib/api.server';
import { NEW_CONTACT_SENTINEL, findEmailDupe } from '$lib/contact-dupes';
import { lineTax, policyRate } from '$lib/line-tax';
import { error, fail, redirect } from '@sveltejs/kit';
import {
  type EstimateCreateInput,
  type EstimateLineItemInput,
  type LineItemType,
  addMoney,
  contactCreateSchema,
  estimateCreateSchema,
  multiplyMoney,
  sumMoney,
} from '@thalermark/validation';
import type { Actions, PageServerLoad } from './$types';

// The ContactPicker posts `contactId` as the sentinel for "+ Add new
// contact": pull the inline name + email, create the contact first, then use
// the returned id for the estimate POST. Mirrors /invoices/new.

// Line item field names on the form — multi-value inputs, zipped by index
// on the server. Matches the names emitted by +page.svelte's {#each rows}.
const LINE_FIELD_DESCRIPTION = 'li_description';
const LINE_FIELD_QUANTITY = 'li_quantity';
// Free-text unit of measure; one value per row so getAll() stays index-aligned.
const LINE_FIELD_UNIT_LABEL = 'li_unitLabel';
const LINE_FIELD_UNIT_PRICE = 'li_unitPrice';
const LINE_FIELD_SOURCE_ITEM_ID = 'li_sourceItemId';
// Product/service <select> — one value per row, always submitted.
const LINE_FIELD_TYPE = 'li_type';
const LINE_FIELD_TAXABLE = 'li_taxable';
const LINE_FIELD_TAX_POLICY_ID = 'li_taxPolicyId';

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  // The contact selector is a type-ahead (ContactPicker) searching
  // /contacts/search on demand, so the page no longer ships the full list.
  const companiesRes = await client.api.companies.$get();
  if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
  const { companies } = await companiesRes.json();
  const company = pickActiveCompany(event.cookies, companies);
  if (!company) throw error(500, 'no company in this workspace');

  // Active tax policies for the per-line tax picker (scoped to this company).
  const polRes = await client.api['tax-policies'].$get({
    query: { companyId: company.id, limit: '100' },
  });
  const taxPolicies = polRes.ok ? (await polRes.json()).taxPolicies : [];

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
    // Company-level estimate "show" defaults — seed the from-block checkboxes on
    // a fresh estimate. Separate from the invoice defaults (per-document-type).
    showDefaults: {
      showAddress: company.showAddressOnEstimate,
      showPhone: company.showPhoneOnEstimate,
      showEmail: company.showEmailOnEstimate,
    },
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
  // re-shows the picked/typed contact name.
  contactName: string;
  newContactName: string;
  newContactEmail: string;
  number: string;
  issueDate: string;
  expiresOn: string;
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
  }[];
};

function readForm(data: FormData): FormValues {
  const descriptions = data.getAll(LINE_FIELD_DESCRIPTION).map((v) => String(v));
  const quantities = data.getAll(LINE_FIELD_QUANTITY).map((v) => String(v));
  const unitLabels = data.getAll(LINE_FIELD_UNIT_LABEL).map((v) => String(v));
  const unitPrices = data.getAll(LINE_FIELD_UNIT_PRICE).map((v) => String(v));
  const sourceItemIds = data.getAll(LINE_FIELD_SOURCE_ITEM_ID).map((v) => String(v));
  const types = data.getAll(LINE_FIELD_TYPE).map((v) => String(v));
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
  }));
  return {
    contactId: String(data.get('contactId') ?? '').trim(),
    contactName: String(data.get('contactName') ?? '').trim(),
    newContactName: String(data.get('newContactName') ?? '').trim(),
    newContactEmail: String(data.get('newContactEmail') ?? '').trim(),
    number: String(data.get('number') ?? '').trim(),
    issueDate: String(data.get('issueDate') ?? '').trim(),
    expiresOn: String(data.get('expiresOn') ?? '').trim(),
    notes: String(data.get('notes') ?? '').trim(),
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
    const companyId = (await loadCompanyId(event)) ?? '';

    // Inline-create branch: validate the contact fields, POST /api/contacts,
    // and swap the returned UUID into contactId before continuing. Mirrors
    // /invoices/new. On failure, re-render in new-mode with field errors
    // (values.contactId stays the sentinel so the inline block re-opens).
    let resolvedContactId = values.contactId;
    // On inline-create recovery the picker re-seeds from values.contactId +
    // values.contactName so it shows the new contact linked, not the sentinel.
    let createdName: string | undefined;
    if (values.contactId === NEW_CONTACT_SENTINEL) {
      const parsedCust = contactCreateSchema.safeParse({
        companyId,
        name: values.newContactName,
        email: values.newContactEmail === '' ? undefined : values.newContactEmail,
      });
      if (!parsedCust.success) {
        const contactErrors: Record<string, string> = {};
        for (const issue of parsedCust.error.issues) {
          const key = String(issue.path[0] ?? '_');
          if (!contactErrors[key]) contactErrors[key] = issue.message;
        }
        return fail(400, { values, contactErrors });
      }
      // HARD BLOCK on email exact match. Search by the email server-side (q
      // matches name OR email) so the check is correct at any contact count and
      // closes the race where another tab created the dupe between load() and POST.
      if (parsedCust.data.email) {
        const listRes = await client.api.contacts.$get({
          query: { companyId, q: parsedCust.data.email },
        });
        if (listRes.ok) {
          const { contacts: list } = await listRes.json();
          const emailDupe = findEmailDupe(parsedCust.data.email, list);
          if (emailDupe) {
            return fail(409, {
              values,
              contactErrors: { email: 'email_dupe' },
              dupeContact: { id: emailDupe.id, name: emailDupe.name },
            });
          }
        }
      }
      const custRes = await client.api.contacts.$post({ json: parsedCust.data });
      if (!custRes.ok) {
        const body = (await custRes.json().catch(() => null)) as { error?: string } | null;
        return fail(custRes.status, {
          values,
          contactErrors: { _: body?.error ?? 'contact_create_failed' },
        });
      }
      const createdContact = await custRes.json();
      resolvedContactId = createdContact.id;
      createdName = createdContact.name;
    }

    // Server is authority for money math — same helpers the page uses for
    // live preview, so the form works without JS and the live preview can't
    // drift from what's stored. Line tax rate is resolved from the policy; the
    // estimate tax is the derived sum of line tax.
    const policies = await loadPolicyRates(event, companyId);
    const computedLines: EstimateLineItemInput[] = values.lineItems.map((row, i) => {
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

    const payload: EstimateCreateInput = {
      companyId,
      contactId: resolvedContactId,
      number: values.number,
      issueDate: values.issueDate,
      expiresOn: values.expiresOn === '' ? undefined : values.expiresOn,
      subtotal,
      tax,
      total,
      notes: values.notes === '' ? undefined : values.notes,
      showAddress: values.showAddress,
      showPhone: values.showPhone,
      showEmail: values.showEmail,
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
      // If we came via inline-create, the contact was already persisted — swap
      // the sentinel for the real id + name so the picker shows them linked.
      return fail(400, {
        values: createdName
          ? { ...values, contactId: resolvedContactId, contactName: createdName }
          : values,
        fieldErrors,
      });
    }

    const res = await client.api.estimates.$post({ json: parsed.data });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      const code = body?.error ?? 'create_failed';
      const formError =
        code === 'estimate_number_taken'
          ? 'Estimate number already used for this company. Try another.'
          : code === 'customer_company_mismatch'
            ? 'Selected contact does not belong to this company.'
            : code === 'contact_not_found'
              ? 'Selected contact no longer exists.'
              : code;
      return fail(res.status, {
        values: createdName
          ? { ...values, contactId: resolvedContactId, contactName: createdName }
          : values,
        formError,
      });
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
  return pickActiveCompany(event.cookies, companies)?.id;
}

// Policy id → rate map for the authoritative line-tax recompute (includeArchived
// so a just-archived policy still resolves its snapshot rate).
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

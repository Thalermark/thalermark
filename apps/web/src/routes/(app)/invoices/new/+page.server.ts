import { pickActiveCompany } from '$lib/active-company';
import { serverApiClient } from '$lib/api.server';
import { findEmailDupe } from '$lib/contact-dupes';
import { lineTax, policyRate } from '$lib/line-tax';
import { error, fail, redirect } from '@sveltejs/kit';
import {
  type InvoiceCreateInput,
  type InvoiceLineItemInput,
  type LineItemType,
  addMoney,
  contactCreateSchema,
  invoiceCreateSchema,
  multiplyMoney,
  sumMoney,
} from '@thalermark/validation';
import type { Actions, PageServerLoad } from './$types';

// Sentinel contactId value emitted by the "+ Add new contact" option in
// the invoice form's dropdown. The action branches on it: instead of
// treating the value as a UUID, it pulls the inline name + email fields
// and creates the contact first, then uses the returned id for the
// invoice POST. Mirrors the literal in +page.svelte.
const NEW_CONTACT_SENTINEL = '__new__';

// Line item field names on the form. Each is a multi-value input (one per
// row); the server zips them by index. Matches the names emitted by
// +page.svelte's {#each rows} block.
const LINE_FIELD_DESCRIPTION = 'li_description';
const LINE_FIELD_QUANTITY = 'li_quantity';
const LINE_FIELD_UNIT_PRICE = 'li_unitPrice';
const LINE_FIELD_SOURCE_ITEM_ID = 'li_sourceItemId';
// Per-row product/service type — a plain <select> that always submits one
// value per row, so its getAll() stays index-aligned with the other line
// fields (no hidden-input dance, unlike the taxable checkbox). Drives the
// ledger revenue split; the schema defaults a missing/garbage value to service.
const LINE_FIELD_TYPE = 'li_type';
// Per-row tax: a hidden "1"/"0" flag + the chosen policy id. Hidden inputs
// (not a checkbox) so every row always submits a value and the index-zip below
// stays aligned. The rate is resolved server-side from the policy, never
// trusted from the client — same authority model as the recomputed amount.
const LINE_FIELD_TAXABLE = 'li_taxable';
const LINE_FIELD_TAX_POLICY_ID = 'li_taxPolicyId';

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  // Scope the contact dropdown to the active company (the nav switcher's pick).
  const { activeCompanyId } = await event.parent();
  const custQuery: Record<string, string> = {};
  if (activeCompanyId) custQuery.companyId = activeCompanyId;
  const [companiesRes, contactsRes] = await Promise.all([
    client.api.companies.$get(),
    client.api.contacts.$get({ query: custQuery }),
  ]);
  if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
  if (!contactsRes.ok) throw error(contactsRes.status, 'failed to load contacts');
  const { companies } = await companiesRes.json();
  const { contacts } = await contactsRes.json();
  const company = pickActiveCompany(event.cookies, companies);
  if (!company) throw error(500, 'no company in this workspace');

  // Active tax policies for the per-line tax picker (scoped to this company).
  const polRes = await client.api['tax-policies'].$get({
    query: { companyId: company.id, limit: '100' },
  });
  const taxPolicies = polRes.ok ? (await polRes.json()).taxPolicies : [];

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
    // Company-level "show on invoices" defaults — seed the from-block checkboxes
    // on a fresh invoice. The user can override per invoice; the API persists
    // whatever the form submits.
    showDefaults: {
      showAddress: company.showAddressOnInvoice,
      showPhone: company.showPhoneOnInvoice,
      showEmail: company.showEmailOnInvoice,
    },
    // email is loaded alongside name so the dupe-detection helper (8.6b)
    // can match against it client-side without an extra round-trip. The
    // dropdown render only uses {id, name}; the rest is opaque to the UI.
    contacts: contacts
      .map((c) => ({ id: c.id, name: c.name, email: c.email ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    // Active policies for the per-line tax picker; pared to what the UI needs.
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
  newContactName: string;
  newContactEmail: string;
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
    // Empty hidden input (hand-typed line) → undefined, so the schema's
    // optional uuid passes and the column stays null.
    sourceItemId: (sourceItemIds[i] ?? '').trim() || undefined,
    // Only the two valid enum values pass through; anything else → undefined so
    // the API defaults the line to 'service'.
    type: types[i] === 'product' ? 'product' : types[i] === 'service' ? 'service' : undefined,
    taxable: (taxables[i] ?? '0') === '1',
    taxPolicyId: (taxPolicyIds[i] ?? '').trim() || undefined,
  }));
  return {
    contactId: String(data.get('contactId') ?? '').trim(),
    newContactName: String(data.get('newContactName') ?? '').trim(),
    newContactEmail: String(data.get('newContactEmail') ?? '').trim(),
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

export const actions: Actions = {
  default: async (event) => {
    const client = serverApiClient(event);
    const data = await event.request.formData();
    const values = readForm(data);
    const companyId = (await loadCompanyId(event)) ?? '';

    // Inline-create branch: validate the contact fields, POST /api/contacts,
    // and swap the returned UUID into `contactId` before continuing to the
    // invoice POST. Schema reuses contactCreateSchema (same shape as the
    // standalone /contacts/new form, just with fewer fields surfaced).
    // On failure, render the form back in new-mode with field errors —
    // values.contactId stays as the sentinel so the inline block re-opens.
    let resolvedContactId = values.contactId;
    let extraContact: { id: string; name: string } | undefined;
    if (values.contactId === NEW_CONTACT_SENTINEL) {
      const contactInput = {
        companyId,
        name: values.newContactName,
        email: values.newContactEmail === '' ? undefined : values.newContactEmail,
      };
      const parsedCust = contactCreateSchema.safeParse(contactInput);
      if (!parsedCust.success) {
        const contactErrors: Record<string, string> = {};
        for (const issue of parsedCust.error.issues) {
          const key = String(issue.path[0] ?? '_');
          if (!contactErrors[key]) contactErrors[key] = issue.message;
        }
        return fail(400, { values, contactErrors });
      }

      // Dupe-detect: HARD BLOCK on email exact match. Re-fetch the list
      // server-side to close the race where another tab created the dupe
      // between load() and this POST. Name fuzzy match stays advisory and
      // is handled client-side only (live hint, no submit block).
      const listRes = await client.api.contacts.$get({ query: { companyId } });
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
      extraContact = { id: createdContact.id, name: createdContact.name };
    }

    // Server is authority for money math — same helpers the page uses for
    // live preview, so the form works without JS (zero-row totals still
    // compute). Schema validation runs against these computed values. The line
    // tax rate is resolved from the policy here (not trusted from the client),
    // and the invoice tax is the derived sum of line tax.
    const policies = await loadPolicyRates(event, companyId);
    const computedLines: InvoiceLineItemInput[] = values.lineItems.map((row, i) => {
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

    const payload: InvoiceCreateInput = {
      companyId,
      contactId: resolvedContactId,
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
      // If we got here via the inline-create branch, the contact was already
      // persisted — swap the sentinel for the real id so the re-render
      // pre-selects them and surfaces extraContact in the dropdown.
      return fail(400, {
        values: extraContact ? { ...values, contactId: extraContact.id } : values,
        fieldErrors,
        extraContact,
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
            ? 'Selected contact does not belong to this company.'
            : code === 'contact_not_found'
              ? 'Selected contact no longer exists.'
              : code;
      // Same recovery as schema fail above: if a contact was just created,
      // pre-select them on the re-render so the user doesn't lose them or
      // accidentally duplicate via a second sentinel pick.
      return fail(res.status, {
        values: extraContact ? { ...values, contactId: extraContact.id } : values,
        formError,
        extraContact,
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
  return pickActiveCompany(event.cookies, companies)?.id;
}

// Policy id → rate map for the authoritative line-tax recompute. includeArchived
// so a line referencing a just-archived policy still resolves its rate.
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

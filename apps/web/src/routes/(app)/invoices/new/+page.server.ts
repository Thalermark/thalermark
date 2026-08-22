import { pickActiveCompany } from '$lib/active-company';
import { apiErrorMessage } from '$lib/api-errors';
import { type ServerApiClient, serverApiClient } from '$lib/api.server';
import { NEW_CONTACT_SENTINEL, findEmailDupe } from '$lib/contact-dupes';
import { computeInvoiceLines } from '$lib/invoice-lines';
import { error, fail, redirect } from '@sveltejs/kit';
import {
  type InvoiceCreateInput,
  type LineItemType,
  addMoney,
  contactCreateSchema,
  invoiceCreateSchema,
  localDayPlus,
  localToday,
  sumMoney,
  timeEntryQuantity,
} from '@thalermark/validation';
import type { Actions, PageServerLoad } from './$types';

// The ContactPicker posts `contactId` as the sentinel when the user chose
// "+ Add new contact". The action branches on it: instead of treating the
// value as a UUID, it pulls the inline name + email fields and creates the
// contact first, then uses the returned id for the invoice POST.

// Line item field names on the form. Each is a multi-value input (one per
// row); the server zips them by index. Matches the names emitted by
// +page.svelte's {#each rows} block.
const LINE_FIELD_DESCRIPTION = 'li_description';
const LINE_FIELD_QUANTITY = 'li_quantity';
// Free-text unit of measure ("hour", "sq ft"). One value per row (always
// present, even when empty), so getAll() stays index-aligned with the others.
const LINE_FIELD_UNIT_LABEL = 'li_unitLabel';
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
const LINE_FIELD_TIME_ENTRY_ID = 'li_timeEntryId';
const LINE_FIELD_TAXABLE = 'li_taxable';
const LINE_FIELD_TAX_POLICY_ID = 'li_taxPolicyId';

// Unbilled hours for one job, shaped for the checkbox list and for turning into
// invoice lines. Best-effort: a failed fetch renders the form without the time
// block rather than failing the page.
async function loadUnbilledTime(client: ServerApiClient, jobId: string) {
  const res = await client.api.jobs[':id'].time.$get({
    param: { id: jobId },
    query: { unbilled: 'true' },
  });
  if (!res.ok) return { entries: [], billingUnit: 'hour' as const };
  const { timeEntries, billingUnit } = await res.json();
  return {
    // The job's own unit rides along (TMC-264). Deriving the quantity from
    // minutes here would invoice three 30-minute visits as "1.5 visits".
    billingUnit,
    entries: timeEntries
      .map((t) => ({
        id: t.id,
        entryDate: t.entryDate,
        minutes: t.minutes,
        quantity: timeEntryQuantity(t, billingUnit),
        startTime: t.startTime,
        endTime: t.endTime,
        note: t.note,
        rate: t.rate,
      }))
      // An entry recording nothing billable in its job's unit is skipped rather
      // than seeded as a zero line.
      .filter((t) => t.quantity !== null),
  };
}

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  // The contact selector is a type-ahead (ContactPicker) that searches
  // /contacts/search on demand, so the page no longer ships the full contact
  // list — just enough to resolve the active company.
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

  // Jobs (TMC-181). Open jobs for the attach picker — closed ones are filed
  // away and offering them is how the list stops being usable.
  const jobsRes = await client.api.jobs.$get({
    query: { companyId: company.id, status: 'open', limit: '100' },
  });
  const jobs = jobsRes.ok
    ? (await jobsRes.json()).jobs.map((j) => ({
        id: j.id,
        name: j.name,
        contactId: j.contactId,
        contactName: j.contactName,
      }))
    : [];

  // Arriving from a job's "Bill this job" carries ?jobId, and that is the only
  // path that loads unbilled hours. One job's worth is a cheap read; every open
  // job's would be N calls for a list the user probably won't use. It is also
  // the honest entry point — you decide to bill a job while looking at the job,
  // not while staring at an empty invoice.
  const jobId = event.url.searchParams.get('jobId') ?? '';
  const unbilled =
    jobId && jobs.some((j) => j.id === jobId)
      ? await loadUnbilledTime(client, jobId)
      : { entries: [], billingUnit: 'hour' as const };

  // The job's customer, for prefilling the contact picker when billing a job.
  // Null when the job has none — a job doesn't need a customer to be useful.
  const activeJob = jobs.find((j) => j.id === jobId);
  const jobContact =
    activeJob?.contactId && activeJob.contactName
      ? { id: activeJob.contactId, name: activeJob.contactName }
      : null;

  return {
    companyId: company.id,
    // Resolved server-side through the company's timezone (TMC-258). The form
    // used to seed these from the browser clock in UTC, so an invoice raised in
    // the evening was issued on tomorrow — and the issue date is what revenue
    // recognition posts on, so the ledger inherited the mistake.
    today: localToday(company.timezone),
    dueDefault: localDayPlus(company.timezone, 30),
    suggestedNumber,
    jobs,
    jobId: jobs.some((j) => j.id === jobId) ? jobId : '',
    jobContact,
    unbilledTime: unbilled.entries,
    billingUnit: unbilled.billingUnit,
    // Company-level "show on invoices" defaults — seed the from-block checkboxes
    // on a fresh invoice. The user can override per invoice; the API persists
    // whatever the form submits.
    showDefaults: {
      showAddress: company.showAddressOnInvoice,
      showPhone: company.showPhoneOnInvoice,
      showEmail: company.showEmailOnInvoice,
    },
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
  // Round-trips the ContactPicker's visible search text so a fail() re-render
  // shows the picked/typed contact name again (the page no longer loads the
  // full list to look a UUID's name back up).
  contactName: string;
  newContactName: string;
  newContactEmail: string;
  number: string;
  issueDate: string;
  dueDate: string;
  notes: string;
  showAddress: boolean;
  showPhone: boolean;
  showEmail: boolean;
  // The job this invoice belongs to, and which of its unbilled entries the user
  // ticked. Both empty on an ordinary invoice.
  jobId: string;
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
    // Empty unit input (unitless line) → undefined so the column stays null.
    unitLabel: (unitLabels[i] ?? '').trim() || undefined,
    unitPrice: (unitPrices[i] ?? '').trim(),
    // Empty hidden input (hand-typed line) → undefined, so the schema's
    // optional uuid passes and the column stays null.
    sourceItemId: (sourceItemIds[i] ?? '').trim() || undefined,
    // Only the two valid enum values pass through; anything else → undefined so
    // the API defaults the line to 'service'.
    type: types[i] === 'product' ? 'product' : types[i] === 'service' ? 'service' : undefined,
    taxable: (taxables[i] ?? '0') === '1',
    taxPolicyId: (taxPolicyIds[i] ?? '').trim() || undefined,
    // Present only on a row seeded from tracked time. Empty for a typed row.
    timeEntryId: (timeEntryIds[i] ?? '').trim() || undefined,
  }));
  return {
    contactId: String(data.get('contactId') ?? '').trim(),
    contactName: String(data.get('contactName') ?? '').trim(),
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
    jobId: String(data.get('jobId') ?? '').trim(),
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
    // On inline-create recovery (contact saved, invoice POST failed) the
    // picker re-seeds from values.contactId + values.contactName, so it shows
    // the freshly-created contact as linked instead of bouncing to the sentinel.
    let createdName: string | undefined;
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

      // Dupe-detect: HARD BLOCK on email exact match. Search by the email
      // server-side (q matches name OR email) so the check is correct
      // regardless of contact count and closes the race where another tab
      // created the dupe between load() and this POST. Name fuzzy match stays
      // advisory and is handled client-side only (live hint, no submit block).
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
          contactErrors: {
            _: apiErrorMessage(body?.error, 'That customer could not be created. Try again.', body),
          },
        });
      }
      const createdContact = await custRes.json();
      resolvedContactId = createdContact.id;
      createdName = createdContact.name;
    }

    // Server is authority for money math — same helpers the page uses for
    // live preview, so the form works without JS (zero-row totals still
    // compute). Schema validation runs against these computed values. The line
    // tax rate is resolved from the policy here (not trusted from the client),
    // and the invoice tax is the derived sum of line tax.
    // Tracked hours are ORDINARY ROWS by the time they get here — the form seeds
    // them into the line-item table, so they flow through the same compute path
    // as a typed row and nothing special happens on this side. Each hour row
    // carries its timeEntryId, and the API reads the link off the lines.
    const policies = await loadPolicyRates(event, companyId);
    const computedLines = computeInvoiceLines(values.lineItems, policies);
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
      jobId: values.jobId || undefined,
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
      // persisted — swap the sentinel for the real id + name so the re-render
      // shows them linked in the picker instead of re-opening the new form.
      return fail(400, {
        values: createdName
          ? { ...values, contactId: resolvedContactId, contactName: createdName }
          : values,
        fieldErrors,
      });
    }

    const res = await client.api.invoices.$post({ json: parsed.data });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      const code = apiErrorMessage(body?.error, 'That could not be created. Try again.', body);
      const formError =
        code === 'invoice_number_taken'
          ? 'Invoice number already used for this company. Try another.'
          : code === 'customer_company_mismatch'
            ? 'Selected contact does not belong to this company.'
            : code === 'contact_not_found'
              ? 'Selected contact no longer exists.'
              : code;
      // Same recovery as schema fail above: if a contact was just created,
      // keep them linked on the re-render so the user doesn't lose them or
      // accidentally duplicate via a second sentinel pick.
      return fail(res.status, {
        values: createdName
          ? { ...values, contactId: resolvedContactId, contactName: createdName }
          : values,
        formError,
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

import {
  bills,
  contacts,
  estimateLineItems,
  estimates,
  expenses,
  invoiceLineItems,
  invoices,
  items,
  jobs,
} from '@thalermark/db';
import { type SearchEntityType, toCents } from '@thalermark/validation';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { buildBody, digitsOnly } from './normalize.js';
import type { Projector, SearchDocument, SearchHandle } from './types.js';

// One projector per searchable entity (TMC-198).
//
// Every one filters `account_id = $1 AND id = ANY($2)` explicitly rather than
// leaning on RLS, so the same function works on a tenant transaction (the
// request path) and on a plain pooled connection (the Stripe webhook, the
// public estimate routes, the reindex sweep). Mirrors the repo-wide rule that
// API selects filter account_id even though the policy would.
//
// An id the projector does not return is deleted from the index. See the
// Projector type for why that one rule is the whole delete story.

// Line-item descriptions are what make "gutter cleaning" find the invoice it
// was billed on. Fetched separately and grouped in JS rather than as a SQL
// string_agg: the aggregate would have to be correlated through the join to
// contacts, and getting that wrong silently multiplies rows.
async function lineTextByParent(
  handle: SearchHandle,
  accountId: string,
  ids: string[],
  kind: 'invoice' | 'estimate',
): Promise<Map<string, string[]>> {
  const rows =
    kind === 'invoice'
      ? await handle
          .select({
            parentId: invoiceLineItems.invoiceId,
            description: invoiceLineItems.description,
            position: invoiceLineItems.position,
          })
          .from(invoiceLineItems)
          .where(
            and(
              eq(invoiceLineItems.accountId, accountId),
              inArray(invoiceLineItems.invoiceId, ids),
            ),
          )
          .orderBy(asc(invoiceLineItems.position))
      : await handle
          .select({
            parentId: estimateLineItems.estimateId,
            description: estimateLineItems.description,
            position: estimateLineItems.position,
          })
          .from(estimateLineItems)
          .where(
            and(
              eq(estimateLineItems.accountId, accountId),
              inArray(estimateLineItems.estimateId, ids),
            ),
          )
          .orderBy(asc(estimateLineItems.position));

  const byParent = new Map<string, string[]>();
  for (const row of rows) {
    const list = byParent.get(row.parentId);
    if (list) list.push(row.description);
    else byParent.set(row.parentId, [row.description]);
  }
  return byParent;
}

const projectInvoices: Projector = async (handle, accountId, ids) => {
  const rows = await handle
    .select({
      id: invoices.id,
      companyId: invoices.companyId,
      number: invoices.number,
      status: invoices.status,
      issueDate: invoices.issueDate,
      total: invoices.total,
      notes: invoices.notes,
      paymentReference: invoices.paymentReference,
      updatedAt: invoices.updatedAt,
      contactName: contacts.name,
    })
    .from(invoices)
    .leftJoin(contacts, eq(contacts.id, invoices.contactId))
    .where(and(eq(invoices.accountId, accountId), inArray(invoices.id, ids)));

  const lines = await lineTextByParent(
    handle,
    accountId,
    rows.map((r) => r.id),
    'invoice',
  );

  // Voided invoices stay indexed, with status 'voided'. Voiding is the only way
  // out of a wrong invoice, so making it unfindable would hide exactly the
  // document someone is looking for when they go looking.
  return rows.map((r) => ({
    entityType: 'invoice' as const,
    entityId: r.id,
    companyId: r.companyId,
    title: r.number,
    subtitle: r.contactName ?? null,
    ref: r.number,
    body: buildBody([r.notes, r.paymentReference, ...(lines.get(r.id) ?? [])]),
    status: r.status,
    amountCents: toCents(r.total),
    occurredOn: r.issueDate,
    entityUpdatedAt: r.updatedAt,
  }));
};

const projectEstimates: Projector = async (handle, accountId, ids) => {
  const rows = await handle
    .select({
      id: estimates.id,
      companyId: estimates.companyId,
      number: estimates.number,
      status: estimates.status,
      issueDate: estimates.issueDate,
      total: estimates.total,
      notes: estimates.notes,
      updatedAt: estimates.updatedAt,
      contactName: contacts.name,
    })
    .from(estimates)
    .leftJoin(contacts, eq(contacts.id, estimates.contactId))
    .where(and(eq(estimates.accountId, accountId), inArray(estimates.id, ids)));

  const lines = await lineTextByParent(
    handle,
    accountId,
    rows.map((r) => r.id),
    'estimate',
  );

  return rows.map((r) => ({
    entityType: 'estimate' as const,
    entityId: r.id,
    companyId: r.companyId,
    title: r.number,
    subtitle: r.contactName ?? null,
    ref: r.number,
    body: buildBody([r.notes, ...(lines.get(r.id) ?? [])]),
    status: r.status,
    amountCents: toCents(r.total),
    occurredOn: r.issueDate,
    entityUpdatedAt: r.updatedAt,
  }));
};

const projectContacts: Projector = async (handle, accountId, ids) => {
  const rows = await handle
    .select()
    .from(contacts)
    .where(and(eq(contacts.accountId, accountId), inArray(contacts.id, ids)));

  // Address and phone go in the body, not the title: someone searching a street
  // name is looking for the customer, and the digits form is what makes a bare
  // "5551234" match a formatted number.
  return rows.map((r) => ({
    entityType: 'contact' as const,
    entityId: r.id,
    companyId: r.companyId,
    title: r.name,
    subtitle: r.email ?? r.phone ?? null,
    ref: null,
    body: buildBody([
      r.email,
      r.phone,
      digitsOnly(r.phone),
      r.addressLine1,
      r.addressLine2,
      r.city,
      r.region,
      r.postalCode,
      r.country,
      r.notes,
    ]),
    // Archived contacts stay indexed and are marked so the results page can
    // grey them, matching items. Archiving takes a name out of the pickers, not
    // out of the past — someone searching an old customer's name is asking
    // about the work, and hiding the answer would be the wrong kind of tidy.
    status: r.archivedAt ? 'archived' : null,
    amountCents: null,
    occurredOn: null,
    entityUpdatedAt: r.updatedAt,
  }));
};

const projectExpenses: Projector = async (handle, accountId, ids) => {
  // Soft-deleted expenses are dropped from the index entirely — deletion is
  // deletion. Contrast items below, where archiving is filing and stays. Each
  // mirrors what that entity's own list page does.
  const rows = await handle
    .select({
      id: expenses.id,
      companyId: expenses.companyId,
      merchant: expenses.merchant,
      memo: expenses.memo,
      amount: expenses.amount,
      expenseDate: expenses.expenseDate,
      updatedAt: expenses.updatedAt,
    })
    .from(expenses)
    .where(
      and(eq(expenses.accountId, accountId), inArray(expenses.id, ids), isNull(expenses.deletedAt)),
    );

  return rows.map((r) => ({
    entityType: 'expense' as const,
    entityId: r.id,
    companyId: r.companyId,
    title: r.merchant,
    subtitle: null,
    ref: null,
    body: buildBody([r.memo]),
    status: null,
    amountCents: toCents(r.amount),
    occurredOn: r.expenseDate,
    entityUpdatedAt: r.updatedAt,
  }));
};

const projectBills: Projector = async (handle, accountId, ids) => {
  // The vendor's name is the title, because that is what someone remembers
  // about a bill. The reference becomes the subtitle and the ref, so a bill is
  // findable both ways.
  const rows = await handle
    .select({
      id: bills.id,
      companyId: bills.companyId,
      reference: bills.reference,
      memo: bills.memo,
      status: bills.status,
      amount: bills.amount,
      billDate: bills.billDate,
      updatedAt: bills.updatedAt,
      contactName: contacts.name,
    })
    .from(bills)
    .leftJoin(contacts, eq(contacts.id, bills.contactId))
    .where(and(eq(bills.accountId, accountId), inArray(bills.id, ids)));

  return rows.map((r) => ({
    entityType: 'bill' as const,
    entityId: r.id,
    companyId: r.companyId,
    title: r.contactName ?? r.reference ?? 'Bill',
    subtitle: r.reference ?? null,
    ref: r.reference,
    body: buildBody([r.memo]),
    status: r.status,
    amountCents: toCents(r.amount),
    occurredOn: r.billDate,
    entityUpdatedAt: r.updatedAt,
  }));
};

const projectJobs: Projector = async (handle, accountId, ids) => {
  const rows = await handle
    .select({
      id: jobs.id,
      companyId: jobs.companyId,
      name: jobs.name,
      status: jobs.status,
      startedOn: jobs.startedOn,
      updatedAt: jobs.updatedAt,
      contactName: contacts.name,
    })
    .from(jobs)
    .leftJoin(contacts, eq(contacts.id, jobs.contactId))
    .where(and(eq(jobs.accountId, accountId), inArray(jobs.id, ids)));

  // Jobs carry no free text of their own and no money — their money is derived
  // from allocations and time entries, and deriving it here would make every
  // expense and time-entry write a job reindex. If "find receipts for the Smith
  // job" is ever wanted, that is the trade to reopen; see the note on
  // PUT /api/expenses/:id/allocations.
  return rows.map((r) => ({
    entityType: 'job' as const,
    entityId: r.id,
    companyId: r.companyId,
    title: r.name,
    subtitle: r.contactName ?? null,
    ref: null,
    body: null,
    status: r.status,
    amountCents: null,
    occurredOn: r.startedOn,
    entityUpdatedAt: r.updatedAt,
  }));
};

const projectItems: Projector = async (handle, accountId, ids) => {
  // Archived items stay indexed and are marked so the results page can grey
  // them. Archiving is filing, not deletion — an archived item is exactly what
  // someone is looking for when they ask "what did we used to charge for this".
  const rows = await handle
    .select({
      id: items.id,
      companyId: items.companyId,
      name: items.name,
      description: items.description,
      unitPrice: items.unitPrice,
      archivedAt: items.archivedAt,
      updatedAt: items.updatedAt,
    })
    .from(items)
    .where(and(eq(items.accountId, accountId), inArray(items.id, ids)));

  return rows.map((r) => ({
    entityType: 'item' as const,
    entityId: r.id,
    companyId: r.companyId,
    title: r.name,
    subtitle: null,
    ref: null,
    body: buildBody([r.description]),
    status: r.archivedAt ? 'archived' : null,
    amountCents: toCents(r.unitPrice),
    occurredOn: null,
    entityUpdatedAt: r.updatedAt,
  }));
};

export const PROJECTORS: Record<SearchEntityType, Projector> = {
  invoice: projectInvoices,
  estimate: projectEstimates,
  contact: projectContacts,
  expense: projectExpenses,
  bill: projectBills,
  job: projectJobs,
  item: projectItems,
};

export type { SearchDocument };

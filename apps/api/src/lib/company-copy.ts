import {
  type Transaction,
  contacts,
  emailTemplates,
  items,
  recurringInvoiceLineItems,
  recurringInvoices,
  taxPolicies,
} from '@thalermark/db';
import type { CompanyCopyInclude, CompanyCopyResult } from '@thalermark/validation';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

// Copying one company's setup into another.
//
// THE ORDER BELOW IS FORCED, not stylistic. Each step needs the id map the step
// before it produced:
//
//   tax policies → items          (items.tax_policy_id)
//                → contacts
//                → recurring      (recurring.contact_id, and per line
//                                  tax_policy_id + source_item_id)
//
// Every row is minted with a fresh uuidv7 and the TARGET company id. Nothing is
// ever reparented: each entity's update schema deliberately omits companyId
// because a row cannot move between companies — its history is scoped to the one
// it was created under.
//
// All of it runs in the caller's single tenant transaction, so a failure part way
// through leaves no half-copied company. RLS pins account_id only, so a
// same-account cross-company read needs no special handling — but every query
// still filters companyId explicitly, because without it the read would silently
// span every company in the workspace.

// A bounded copy. Well past any real small business's setup, and low enough that
// one transaction can't be made to hold an unreasonable amount of work.
export const MAX_COPY_ROWS = 1000;

export class CopyTooLargeError extends Error {
  readonly entity: string;
  readonly count: number;

  constructor(entity: string, count: number) {
    super(`${entity} has ${count} rows, more than the ${MAX_COPY_ROWS} that can be copied at once`);
    this.name = 'CopyTooLargeError';
    this.entity = entity;
    this.count = count;
  }
}

function guardSize(entity: string, rows: unknown[]): void {
  if (rows.length > MAX_COPY_ROWS) throw new CopyTooLargeError(entity, rows.length);
}

export type CopyScope = {
  accountId: string;
  sourceCompanyId: string;
  targetCompanyId: string;
};

export async function copyCompanyReferenceData(
  tx: Transaction,
  scope: CopyScope,
  include: CompanyCopyInclude,
): Promise<CompanyCopyResult> {
  const result: CompanyCopyResult = {
    taxPolicies: 0,
    items: 0,
    contacts: 0,
    recurringInvoices: 0,
    emailTemplates: 0,
    logo: false,
    profile: false,
  };

  // old id → new id, threaded through the steps that reference them.
  const policyMap = new Map<string, string>();
  const itemMap = new Map<string, string>();
  const contactMap = new Map<string, string>();

  // --- Tax policies (nothing depends on this being first except everything) ---
  // Copied even when archived: an archived policy is still referenced by historic
  // lines, and the copy should mirror the source's shape rather than quietly
  // resurrect or drop things.
  if (include.taxPolicies) {
    const rows = await tx
      .select()
      .from(taxPolicies)
      .where(
        and(
          eq(taxPolicies.accountId, scope.accountId),
          eq(taxPolicies.companyId, scope.sourceCompanyId),
        ),
      )
      .orderBy(asc(taxPolicies.name));
    guardSize('tax policies', rows);
    if (rows.length > 0) {
      const values = rows.map((r) => {
        const id = uuidv7();
        policyMap.set(r.id, id);
        return {
          id,
          accountId: scope.accountId,
          companyId: scope.targetCompanyId,
          name: r.name,
          ratePct: r.ratePct,
          // At most one default per company is app-enforced, and copying a
          // source that honours it preserves it.
          isDefault: r.isDefault,
          archivedAt: r.archivedAt,
        };
      });
      await tx.insert(taxPolicies).values(values);
      result.taxPolicies = values.length;
    }
  }

  // --- Items (need policyMap) ---
  if (include.items) {
    const rows = await tx
      .select()
      .from(items)
      .where(and(eq(items.accountId, scope.accountId), eq(items.companyId, scope.sourceCompanyId)))
      .orderBy(asc(items.name));
    guardSize('items', rows);
    if (rows.length > 0) {
      const values = rows.map((r) => {
        const id = uuidv7();
        itemMap.set(r.id, id);
        return {
          id,
          accountId: scope.accountId,
          companyId: scope.targetCompanyId,
          name: r.name,
          description: r.description,
          type: r.type,
          unitPrice: r.unitPrice,
          unitLabel: r.unitLabel,
          defaultQuantity: r.defaultQuantity,
          taxable: r.taxable,
          // Remapped, never carried: the source id belongs to the source
          // company's chart. Null when tax policies weren't copied, which is
          // correct — the item is taxable, it just has no named rate here yet.
          taxPolicyId: r.taxPolicyId ? (policyMap.get(r.taxPolicyId) ?? null) : null,
          archivedAt: r.archivedAt,
        };
      });
      await tx.insert(items).values(values);
      result.items = values.length;
    }
  }

  // --- Contacts ---
  if (include.contacts) {
    const rows = await tx
      .select()
      .from(contacts)
      .where(
        and(eq(contacts.accountId, scope.accountId), eq(contacts.companyId, scope.sourceCompanyId)),
      )
      .orderBy(asc(contacts.name));
    guardSize('contacts', rows);
    if (rows.length > 0) {
      const values = rows.map((r) => {
        const id = uuidv7();
        contactMap.set(r.id, id);
        return {
          id,
          accountId: scope.accountId,
          companyId: scope.targetCompanyId,
          name: r.name,
          email: r.email,
          phone: r.phone,
          addressLine1: r.addressLine1,
          addressLine2: r.addressLine2,
          city: r.city,
          region: r.region,
          postalCode: r.postalCode,
          country: r.country,
          notes: r.notes,
          // Carried explicitly — the CSV importer can't express these and always
          // lands customer=true/vendor=false, which would silently demote every
          // vendor in a copied setup.
          isCustomer: r.isCustomer,
          isVendor: r.isVendor,
        };
      });
      await tx.insert(contacts).values(values);
      result.contacts = values.length;
    }
  }

  // --- Recurring invoices (need contactMap, policyMap, itemMap) ---
  if (include.recurringInvoices) {
    const rows = await tx
      .select()
      .from(recurringInvoices)
      .where(
        and(
          eq(recurringInvoices.accountId, scope.accountId),
          eq(recurringInvoices.companyId, scope.sourceCompanyId),
        ),
      )
      .orderBy(asc(recurringInvoices.createdAt));
    guardSize('recurring invoices', rows);

    // A schedule whose customer didn't come across has nowhere to point:
    // contact_id is NOT NULL and RESTRICT, so this would fail loudly rather than
    // silently — skipping is the honest answer, and the count tells the caller.
    const copyable = rows.filter((r) => contactMap.has(r.contactId));

    for (const schedule of copyable) {
      const id = uuidv7();
      await tx.insert(recurringInvoices).values({
        id,
        accountId: scope.accountId,
        companyId: scope.targetCompanyId,
        contactId: contactMap.get(schedule.contactId) as string,
        frequency: schedule.frequency,
        intervalCount: schedule.intervalCount,
        startDate: schedule.startDate,
        // The copy has generated nothing yet, so its cursor starts where the
        // schedule starts rather than wherever the source had got to.
        nextRunDate: schedule.startDate,
        endDate: schedule.endDate,
        maxOccurrences: schedule.maxOccurrences,
        occurrenceCount: 0,
        // PAUSED, always. A copy landing 'active' would have the next sweep
        // email real invoices to real customers from a company nobody has
        // finished setting up.
        status: 'paused',
        netTermsDays: schedule.netTermsDays,
        currency: schedule.currency,
        subtotal: schedule.subtotal,
        tax: schedule.tax,
        total: schedule.total,
        notes: schedule.notes,
      });

      const lines = await tx
        .select()
        .from(recurringInvoiceLineItems)
        .where(
          and(
            eq(recurringInvoiceLineItems.accountId, scope.accountId),
            eq(recurringInvoiceLineItems.recurringInvoiceId, schedule.id),
          ),
        )
        .orderBy(asc(recurringInvoiceLineItems.position));
      if (lines.length > 0) {
        await tx.insert(recurringInvoiceLineItems).values(
          lines.map((l) => ({
            id: uuidv7(),
            accountId: scope.accountId,
            recurringInvoiceId: id,
            position: l.position,
            description: l.description,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            amount: l.amount,
            unitLabel: l.unitLabel,
            type: l.type,
            taxable: l.taxable,
            // The snapshot rate/amount carry verbatim — they're what the line
            // was priced at, not a live lookup.
            taxRatePct: l.taxRatePct,
            taxAmount: l.taxAmount,
            taxPolicyId: l.taxPolicyId ? (policyMap.get(l.taxPolicyId) ?? null) : null,
            // The top-products breadcrumb. Null when items weren't copied, which
            // costs a report attribution but never a wrong figure.
            sourceItemId: l.sourceItemId ? (itemMap.get(l.sourceItemId) ?? null) : null,
          })),
        );
      }
      result.recurringInvoices += 1;
    }
  }

  // --- Email templates ---
  // ONLY the rows that exist. Absent means "use the built-in wording, and track
  // it if we improve it"; writing the current defaults in as rows would silently
  // pin the copy to today's text forever.
  if (include.emailTemplates) {
    const rows = await tx
      .select()
      .from(emailTemplates)
      .where(
        and(
          eq(emailTemplates.accountId, scope.accountId),
          eq(emailTemplates.companyId, scope.sourceCompanyId),
        ),
      );
    if (rows.length > 0) {
      await tx.insert(emailTemplates).values(
        rows.map((r) => ({
          id: uuidv7(),
          accountId: scope.accountId,
          companyId: scope.targetCompanyId,
          type: r.type,
          subject: r.subject,
          body: r.body,
        })),
      );
      result.emailTemplates = rows.length;
    }
  }

  return result;
}

// The company columns worth carrying: how a business presents itself and how it
// keeps its books. Deliberately excludes:
//   * name / businessType — the caller's own decision, and the whole point of a
//     new company is usually that one of them differs
//   * stripe_connect_* — bound to the source's EIN, and uniquely indexed anyway
//   * payment_check_payable_to — names the old legal entity on a cheque
//   * the nudge cache — keyed to the source company's ledger signals
export function copyableProfile(source: {
  businessAddress: string | null;
  businessPhone: string | null;
  businessEmail: string | null;
  replyToEmail: string | null;
  showAddressOnInvoice: boolean;
  showPhoneOnInvoice: boolean;
  showEmailOnInvoice: boolean;
  showAddressOnEstimate: boolean;
  showPhoneOnEstimate: boolean;
  showEmailOnEstimate: boolean;
  accountingMethod: string;
  timezone: string;
  depreciationConvention: string;
  vehicleExpenseMethod: string;
  paymentCashEnabled: boolean;
  paymentCheckEnabled: boolean;
  paymentCheckAddress: string | null;
  paymentVenmoHandle: string | null;
  paymentZelleContact: string | null;
}) {
  return {
    businessAddress: source.businessAddress,
    businessPhone: source.businessPhone,
    businessEmail: source.businessEmail,
    replyToEmail: source.replyToEmail,
    showAddressOnInvoice: source.showAddressOnInvoice,
    showPhoneOnInvoice: source.showPhoneOnInvoice,
    showEmailOnInvoice: source.showEmailOnInvoice,
    showAddressOnEstimate: source.showAddressOnEstimate,
    showPhoneOnEstimate: source.showPhoneOnEstimate,
    showEmailOnEstimate: source.showEmailOnEstimate,
    accountingMethod: source.accountingMethod,
    timezone: source.timezone,
    depreciationConvention: source.depreciationConvention,
    // A standing tax election, so it should survive an incorporation handoff the
    // same way the accounting method and depreciation convention do.
    vehicleExpenseMethod: source.vehicleExpenseMethod,
    paymentCashEnabled: source.paymentCashEnabled,
    paymentCheckEnabled: source.paymentCheckEnabled,
    paymentCheckAddress: source.paymentCheckAddress,
    paymentVenmoHandle: source.paymentVenmoHandle,
    paymentZelleContact: source.paymentZelleContact,
  };
}

// Where a company's logo lives. The company id is IN the path, which is why the
// key can't simply be copied as a string — see StorageProvider.copyObject.
export function logoKeyFor(accountId: string, companyId: string, sourceKey: string): string {
  const ext = sourceKey.slice(sourceKey.lastIndexOf('.') + 1);
  return `accounts/${accountId}/companies/${companyId}/branding/${uuidv7()}.${ext}`;
}

// The check that stops a copy landing on top of an existing setup. Copying into
// a company that already has contacts or items would interleave two sets of
// reference data with no way to tell them apart afterwards.
export async function targetIsEmpty(tx: Transaction, scope: CopyScope): Promise<boolean> {
  const [existingContact] = await tx
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      and(eq(contacts.accountId, scope.accountId), eq(contacts.companyId, scope.targetCompanyId)),
    )
    .limit(1);
  if (existingContact) return false;
  const [existingItem] = await tx
    .select({ id: items.id })
    .from(items)
    .where(and(eq(items.accountId, scope.accountId), eq(items.companyId, scope.targetCompanyId)))
    .limit(1);
  if (existingItem) return false;
  const [existingPolicy] = await tx
    .select({ id: taxPolicies.id })
    .from(taxPolicies)
    .where(
      and(
        eq(taxPolicies.accountId, scope.accountId),
        eq(taxPolicies.companyId, scope.targetCompanyId),
        isNull(taxPolicies.archivedAt),
      ),
    )
    .limit(1);
  return !existingPolicy;
}

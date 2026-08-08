// Small request/SQL helpers shared by the root app and the per-domain route
// sub-apps (apps/api/src/routes/*). Lives in lib/ — not app.ts — so a sub-app
// can import it without a cycle back through app.ts.

import { type Transaction, chartOfAccounts, contacts } from '@thalermark/db';
import { and, eq, inArray } from 'drizzle-orm';
import { reindexEntities } from './search/reindex.js';

// UUIDv7 shape guard for `:id` path params. Most routes validate an id before
// it reaches Postgres so a malformed value returns a clean 400 instead of a
// cast error.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Loose email shape guard for recipient/invite fields validated by hand (not via
// a Zod schema). Shared by the root app and the contacts sub-app.
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// YYYY-MM-DD guard for date query/body params. isValidDateParam also rejects
// impossible calendar dates (e.g. 2026-02-31) that match the shape. Shared by
// the invoices + estimates sub-apps (issue/due date filters).
const DATE_PARAM_RE = /^\d{4}-\d{2}-\d{2}$/;
export function isValidDateParam(s: string): boolean {
  return DATE_PARAM_RE.test(s) && !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime());
}

// Escape the LIKE/ILIKE metacharacters so a search for "50%" or "a_b" matches
// literally instead of as wildcards. Drizzle's ilike() uses the default
// backslash escape character, so backslash itself is escaped too.
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// Stored-object key extension → content-type. The local-FS storage adapter
// doesn't persist content-type metadata, so the serve routes (company logo,
// receipt, /api/files/:token) infer it from the key. Shared by the root app
// and the files sub-app.
const EXT_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  pdf: 'application/pdf',
  webp: 'image/webp',
};

// Content-type to serve a stored object with, inferred from its key extension.
export function mimeForKey(key: string): string {
  const ext = key.slice(key.lastIndexOf('.') + 1).toLowerCase();
  return EXT_MIME[ext] ?? 'application/octet-stream';
}

// Expenses + bills post their open leg against the entity date (not the create
// timestamp) so an expense/bill dated in a prior tax period lands there. Both
// the expenses sub-app and the bills routes call this to turn a YYYY-MM-DD date
// string into a UTC-midnight timestamp for the ledger posting.
export function expenseDateToPostedAt(d: string): Date {
  return new Date(`${d}T00:00:00.000Z`);
}

// Today's date *in the company's zone* — "as of today" should roll over at the
// operator's midnight, not UTC's. The reports use it for "year to date"; the
// invoice mark-paid path uses it to date a receipt whose caller didn't supply a
// date, where truncating `now` to a UTC date would file a Tokyo morning under
// yesterday (TMC-196).
export function localToday(tz: string): string {
  // en-CA formats as YYYY-MM-DD, which is the shape we want everywhere else.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

// Resolves chart_of_accounts row ids to their { code, accountType } within one
// company (scoped by account for defense-in-depth per
// [[architecture_account_id_explicit_filter]]). The expense + bill endpoints
// use it to validate the category/payment account types before posting and to
// recover the codes of a stored account when posting a reversal. Returns a Map
// keyed by id; ids that don't resolve are simply absent. Shared by the expenses
// sub-app and the bills routes.
export async function resolveCoaAccounts(
  tx: Transaction,
  accountId: string,
  companyId: string,
  ids: string[],
): Promise<Map<string, { code: string; accountType: string }>> {
  const unique = Array.from(new Set(ids));
  if (unique.length === 0) return new Map();
  const rows = await tx
    .select({
      id: chartOfAccounts.id,
      code: chartOfAccounts.code,
      accountType: chartOfAccounts.accountType,
    })
    .from(chartOfAccounts)
    .where(
      and(
        eq(chartOfAccounts.accountId, accountId),
        eq(chartOfAccounts.companyId, companyId),
        inArray(chartOfAccounts.id, unique),
      ),
    );
  return new Map(rows.map((r) => [r.id, { code: r.code, accountType: r.accountType }]));
}

// Resolve an expense/bill's buy-from vendor link (shared by expense create +
// update and bill create). Returns null when nothing to link; an {error,status}
// pair for a bad link; otherwise the resolved {id,name} after marking the
// contact is_vendor. Marking is_vendor on link is how an existing customer-only
// contact becomes a vendor too — the buy-from half of the unified-contact
// relationship view. Callers mirror the returned name into expenses.merchant so
// the single on-screen "Vendor" field stays the display string.
export async function resolveVendorLink(
  tx: Transaction,
  accountId: string,
  companyId: string,
  vendorContactId: string | null | undefined,
): Promise<{ id: string; name: string } | { error: string; status: 400 | 404 } | null> {
  if (!vendorContactId) return null;
  const [vendor] = await tx
    .select({
      id: contacts.id,
      companyId: contacts.companyId,
      name: contacts.name,
      isVendor: contacts.isVendor,
    })
    .from(contacts)
    .where(and(eq(contacts.id, vendorContactId), eq(contacts.accountId, accountId)))
    .limit(1);
  if (!vendor) return { error: 'contact_not_found', status: 404 };
  if (vendor.companyId !== companyId) return { error: 'vendor_company_mismatch', status: 400 };
  if (!vendor.isVendor) {
    await tx
      .update(contacts)
      .set({ isVendor: true, updatedAt: new Date() })
      .where(and(eq(contacts.id, vendorContactId), eq(contacts.accountId, accountId)));
    // This mutates a contact while the only audit event written belongs to the
    // expense or bill that triggered it, so the audit-driven reindex never
    // hears about it (TMC-198). The v1 contact document carries no role flags,
    // making this strictly defensive today — but it costs one line and puts the
    // repair next to the mutation, which closes the bug the moment anyone adds
    // a customer/vendor facet to search.
    await reindexEntities(tx, accountId, [{ entityType: 'contact', entityId: vendorContactId }]);
  }
  return { id: vendor.id, name: vendor.name };
}

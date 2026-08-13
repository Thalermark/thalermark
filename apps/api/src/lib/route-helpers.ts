// Small request/SQL helpers shared by the root app and the per-domain route
// sub-apps (apps/api/src/routes/*). Lives in lib/ — not app.ts — so a sub-app
// can import it without a cycle back through app.ts.

import { type Transaction, chartOfAccounts, companies, contacts } from '@thalermark/db';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
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
//
// Re-exported from @thalermark/validation rather than defined here (TMC-258):
// web and mobile have to answer the same question for their date inputs, and
// this route's copy being right while the client's was wrong is exactly how
// INV-0008 got issued on a day its business had not reached yet.
export { localDay, localDayPlus, localToday } from '@thalermark/validation';

// The zone a company keeps its books in, for the write paths that need to date
// something as of today (TMC-258). Falls back to UTC when the company can't be
// read, which is the column's own default — a missing row should not be the
// difference between a date and a 500. Account-scoped for defense in depth per
// [[architecture_account_id_explicit_filter]].
export async function companyTimezone(
  tx: Transaction,
  ids: { accountId: string; companyId: string },
): Promise<string> {
  const [row] = await tx
    .select({ timezone: companies.timezone })
    .from(companies)
    .where(and(eq(companies.id, ids.companyId), eq(companies.accountId, ids.accountId)))
    .limit(1);
  return row?.timezone ?? 'UTC';
}

// Resolves chart_of_accounts row ids to their shape within one company (scoped
// by account for defense-in-depth per
// [[architecture_account_id_explicit_filter]]). The expense + bill endpoints
// use it to validate the category/payment account before posting and to recover
// the codes of a stored account when posting a reversal. Returns a Map keyed by
// id; ids that don't resolve are simply absent. Shared by the expenses sub-app
// and the bills routes.
//
// moneyAccountKind is what "can money move through this?" is decided on since
// TMC-207 — NOT accountType. A type test would accept Accounts Receivable and
// Accumulated Depreciation, which are assets too, and posting against them
// balances while being nonsense. It also has to be the test rather than a code
// list because a credit card is a LIABILITY that money legitimately moves
// through, so no single account_type covers the set.
//
// isActive rides along so a caller can refuse an ARCHIVED account for new work
// while still resolving it for reversals of transactions that already used it.
export async function resolveCoaAccounts(
  tx: Transaction,
  accountId: string,
  companyId: string,
  ids: string[],
): Promise<
  Map<
    string,
    { code: string; accountType: string; moneyAccountKind: string | null; isActive: boolean }
  >
> {
  const unique = Array.from(new Set(ids));
  if (unique.length === 0) return new Map();
  const rows = await tx
    .select({
      id: chartOfAccounts.id,
      code: chartOfAccounts.code,
      accountType: chartOfAccounts.accountType,
      moneyAccountKind: chartOfAccounts.moneyAccountKind,
      isActive: chartOfAccounts.isActive,
    })
    .from(chartOfAccounts)
    .where(
      and(
        eq(chartOfAccounts.accountId, accountId),
        eq(chartOfAccounts.companyId, companyId),
        inArray(chartOfAccounts.id, unique),
      ),
    );
  return new Map(
    rows.map((r) => [
      r.id,
      {
        code: r.code,
        accountType: r.accountType,
        moneyAccountKind: r.moneyAccountKind,
        isActive: r.isActive,
      },
    ]),
  );
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

// The seeded primary money account. Duplicated from ledger.ts's COA_CASH rather
// than imported to keep this module free of a ledger dependency (it is imported
// by routes that never post).
const PRIMARY_MONEY_CODE = '1000';

// Resolves "which of this company's money accounts did the money move through?"
// to the { id, code } the caller needs — the id to store on the row, the code to
// post with (the ledger resolves lines by literal code).
//
// One helper because five flows ask the identical question — expenses, bill
// payments, invoice receipts, owner money and capital purchases — and the answer
// has two easy ways to be wrong that a trial-balance check cannot catch:
//
//   * accepting an account money cannot move through. account_type is not the
//     test: the seed marks Accounts Receivable, Vehicles & Equipment and
//     Accumulated Depreciation as assets, and "paid this bill out of Accumulated
//     Depreciation" posts a BALANCED entry that is nonsense. Membership is
//     money_account_kind.
//   * silently falling back to the primary when the caller named an account that
//     did not resolve, which would bank money into the wrong place while looking
//     like it worked. An explicit id that fails to resolve is an error; only an
//     ABSENT id falls back.
//
// Archived accounts are refused. This is the new-work path; reversals resolve
// the account already stored on the row and never come through here, so
// archiving can never strand a transaction that already used one.
export async function resolveMoneyAccount(
  tx: Transaction,
  args: { accountId: string; companyId: string; moneyAccountId?: string | null | undefined },
): Promise<{ id: string; code: string } | { error: 'invalid_money_account' }> {
  if (args.moneyAccountId) {
    const [picked] = await tx
      .select({ id: chartOfAccounts.id, code: chartOfAccounts.code })
      .from(chartOfAccounts)
      .where(
        and(
          eq(chartOfAccounts.accountId, args.accountId),
          eq(chartOfAccounts.companyId, args.companyId),
          eq(chartOfAccounts.id, args.moneyAccountId),
          isNotNull(chartOfAccounts.moneyAccountKind),
          eq(chartOfAccounts.isActive, true),
        ),
      )
      .limit(1);
    if (!picked) return { error: 'invalid_money_account' };
    return picked;
  }

  const [primary] = await tx
    .select({ id: chartOfAccounts.id, code: chartOfAccounts.code })
    .from(chartOfAccounts)
    .where(
      and(
        eq(chartOfAccounts.accountId, args.accountId),
        eq(chartOfAccounts.companyId, args.companyId),
        eq(chartOfAccounts.code, PRIMARY_MONEY_CODE),
      ),
    )
    .limit(1);
  // The seed guarantees this row; its absence means the chart is broken, which
  // is a crash rather than a 400 — the same call the ledger makes.
  if (!primary) throw new Error(`company ${args.companyId}: primary money account missing`);
  return primary;
}

// The posting CODE for an account already stored on a row.
//
// Deliberately not resolveMoneyAccount: that one guards NEW work and refuses an
// archived account. This is the reversal/repost path, where the account was
// valid when the transaction was recorded and the only correct answer is the one
// the money actually moved through. Refusing it here would strand an edit or a
// delete on any transaction whose account was later archived — and archiving is
// meant to be a filing decision, not something that freezes history.
//
// A null id means the row predates TMC-207 (or took the default), which resolves
// to the primary account — where that money actually went.
export async function storedMoneyCode(
  tx: Transaction,
  args: { accountId: string; companyId: string; moneyAccountId?: string | null | undefined },
): Promise<string> {
  if (args.moneyAccountId) {
    const [row] = await tx
      .select({ code: chartOfAccounts.code })
      .from(chartOfAccounts)
      .where(
        and(
          eq(chartOfAccounts.accountId, args.accountId),
          eq(chartOfAccounts.id, args.moneyAccountId),
        ),
      )
      .limit(1);
    // The FK is RESTRICT, so a stored id that does not resolve means the chart
    // was corrupted out from under the books — a crash, not a silent default.
    if (!row) {
      throw new Error(`money account ${args.moneyAccountId} missing for account ${args.accountId}`);
    }
    return row.code;
  }
  return PRIMARY_MONEY_CODE;
}

import { type Database, type Transaction, companies } from '@thalermark/db';
import { and, eq, isNotNull } from 'drizzle-orm';

// The retirement lock. A retired company has stopped trading — most often a sole
// proprietorship that incorporated, whose books now belong to a different
// taxpayer than the one carrying on. Its ledger is closed for good.
//
// Deliberately its own module for the same reason period-lock.ts is: the posting
// helpers in lib/ledger.ts consult it, and anything that retires a company
// consults both. Keeping the check dependency-free makes that a one-way graph.
//
// Read-only, NOT deleted: the old books still have to be filable years later, so
// every report keeps working and nothing is hidden. Only writes are refused.

// Thrown by assertCompanyActive. Mapped once in app.ts's onError to a 409
// `company_retired`, so every route that posts reports it the same way without
// each one having to catch it — the same shape as PeriodClosedError.
export class CompanyRetiredError extends Error {
  readonly retiredAt: Date;

  constructor(retiredAt: Date) {
    super(`company retired at ${retiredAt.toISOString()}`);
    this.name = 'CompanyRetiredError';
    this.retiredAt = retiredAt;
  }
}

// What a posting is FOR, which decides whether a retired company may accept it.
//
// 'origination' — the business doing new business: raising an invoice, logging an
//   expense, opening a bill, buying equipment, an accountant's adjustment. A
//   retired company refuses all of it.
// 'settlement'  — discharging an obligation that already existed when the company
//   retired: a customer paying an invoice it had already issued, paying a bill it
//   had already opened, a payment on a loan it already owed.
//
// The distinction is load-bearing, not a convenience. Retiring a business does not
// magically collect its receivables — an incorporating sole proprietor routinely
// keeps the invoices they billed under the old name, and someone has to record the
// cheque when it arrives. Without this, "retired" and "unpaid invoices stay with
// the old business" are mutually exclusive.
//
// Origination is the DEFAULT, so a posting helper added later is refused unless
// its author deliberately says otherwise. That is what keeps the rule
// un-bypassable rather than merely widespread.
export type PostingIntent = 'origination' | 'settlement';

// Throws if the company has been retired and the posting would be new business.
// One indexed lookup by primary key, account-scoped for defense in depth
// ([[architecture_account_id_explicit_filter]]).
//
// A missing company is NOT an error here: the posting helpers are always called
// after the caller has already verified company ownership, and inventing a 409
// for a row that doesn't exist would mask the caller's own 404.
export async function assertCompanyActive(
  tx: Database | Transaction,
  args: { accountId: string; companyId: string; intent?: PostingIntent },
): Promise<void> {
  if (args.intent === 'settlement') return;
  const [row] = await tx
    .select({ retiredAt: companies.retiredAt })
    .from(companies)
    .where(
      and(
        eq(companies.id, args.companyId),
        eq(companies.accountId, args.accountId),
        isNotNull(companies.retiredAt),
      ),
    )
    .limit(1);
  if (row?.retiredAt) throw new CompanyRetiredError(row.retiredAt);
}

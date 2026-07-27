import { type Database, type Transaction, periodCloses } from '@thalermark/db';
import { and, desc, eq, isNull } from 'drizzle-orm';

// The period lock (TMC-159). Once a fiscal year is closed, nothing may post into
// it — otherwise a backdated invoice or a late expense silently changes a year
// whose profit has already been rolled into equity and handed to an accountant.
//
// Deliberately its own module rather than part of lib/ledger.ts: the posting
// helpers there consult this, and lib/period-close.ts (which performs a close)
// consults both. Keeping the check dependency-free makes that a one-way graph
// instead of a cycle.
//
// The check is a single indexed lookup against period_closes' partial index over
// live rows. It runs on EVERY posting in the product, which is exactly why the
// closed period is a small table rather than something derived by scanning
// journal entries by source type.

// Thrown by assertPeriodOpen. Mapped once in app.ts's onError to a 409
// `period_closed` carrying closedThrough, so every route that posts — invoices,
// expenses, bills, owner money, purchases, manual adjustments — reports a
// closed year the same way without each one having to catch it.
export class PeriodClosedError extends Error {
  readonly closedThrough: Date;

  constructor(closedThrough: Date) {
    super(`period closed through ${closedThrough.toISOString()}`);
    this.name = 'PeriodClosedError';
    this.closedThrough = closedThrough;
  }
}

// The exclusive upper bound of the company's closed period — the first instant
// that is still open — or null when no year has been closed. Reading the newest
// active close covers the ordinary case (years closed in order) and the odd one
// (a middle year re-opened leaves the later close still standing, and the whole
// span stays locked, which is the safe reading).
export async function closedThroughFor(
  tx: Database | Transaction,
  scope: { accountId: string; companyId: string },
): Promise<Date | null> {
  const [row] = await tx
    .select({ closedThrough: periodCloses.closedThrough })
    .from(periodCloses)
    .where(
      and(
        eq(periodCloses.accountId, scope.accountId),
        eq(periodCloses.companyId, scope.companyId),
        isNull(periodCloses.deletedAt),
      ),
    )
    .orderBy(desc(periodCloses.closedThrough))
    .limit(1);
  return row?.closedThrough ?? null;
}

// Throws if postedAt falls inside a closed period. Strictly-before, matching the
// half-open [start, end) convention every report window uses: closed_through is
// the first instant of the following year, so a posting exactly at it is open.
export async function assertPeriodOpen(
  tx: Database | Transaction,
  args: { accountId: string; companyId: string; postedAt: Date },
): Promise<void> {
  const closedThrough = await closedThroughFor(tx, args);
  if (closedThrough && args.postedAt < closedThrough) {
    throw new PeriodClosedError(closedThrough);
  }
}

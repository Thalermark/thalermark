import { type Database, type Transaction, chartOfAccounts, expenses } from '@thalermark/db';
import { and, eq, gte, isNull, lte, sql } from 'drizzle-orm';

// Where the money went, and whether that is normal for this business.
//
// Extracted from the spending-anomalies route (TMC-229) because two callers now
// need the same windows and must not drift:
//
//   - /spending-anomalies flags SPIKES. It applies thresholds and shows the
//     operator a short list of things that jumped. Deterministic, no model.
//   - the cash-flow nudge needs CONTEXT. It wants to name a category or a
//     merchant rather than restate a total, which is the whole of TMC-229.
//
// The thresholds stay with the route, because "what is worth flagging" is a
// product decision that differs between those two questions. Only the window
// arithmetic and the aggregation live here, because "what is the last 30 days"
// must not differ between them at all.
//
// ROLLING WINDOWS, NOT CALENDAR MONTHS. A calendar month compares a partial
// month against whole ones and reports a spike every 1st of the month. recent =
// the last 30 days including today; baseline = the 90 days before that, divided
// by three to a per-30-day "your typical month".

export type SpendingWindows = {
  today: string;
  recentStart: string;
  baselineEnd: string;
  baselineStart: string;
};

// `today` is the COMPANY's today, resolved through its timezone by the caller
// (TMC-258). The route this came from derived it from `new Date()` in UTC, so
// from 7pm Central its windows were a day ahead of every other figure on the
// dashboard.
export function rollingWindows(today: string): SpendingWindows {
  const dayMs = 86_400_000;
  const base = new Date(`${today}T00:00:00Z`).getTime();
  const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return {
    today,
    recentStart: ymd(base - 29 * dayMs), // last 30 days incl. today
    baselineEnd: ymd(base - 30 * dayMs), // the day before the recent window
    baselineStart: ymd(base - 119 * dayMs), // 90 days before that
  };
}

export type MovementRow = { key: string; label: string; recent: number; typical: number };

// Recent-vs-typical for one grouping, in a single pass over the same rows.
// `typical` is already divided to a per-30-day figure, so a caller comparing
// recent against typical is comparing like with like.
function toMovement(rows: { key: string; label: string; recent: string; baseline: string }[]) {
  return rows.map((r) => ({
    key: r.key,
    label: r.label,
    recent: Number(r.recent),
    // Three 30-day windows in the 90-day baseline.
    typical: Number(r.baseline) / 3,
  }));
}

// Expense rows are the source, NOT the ledger: edits update the row in place and
// deletes set deleted_at, so summing `amount` where deleted_at is null is the
// correct current total with no reversal handling.
function windowFilter(accountId: string, companyId: string, w: SpendingWindows) {
  return and(
    eq(expenses.accountId, accountId),
    eq(expenses.companyId, companyId),
    isNull(expenses.deletedAt),
    gte(expenses.expenseDate, w.baselineStart),
    lte(expenses.expenseDate, w.today),
  );
}

const RECENT = (w: SpendingWindows) =>
  sql<string>`coalesce(sum(${expenses.amount}) filter (where ${expenses.expenseDate} >= ${w.recentStart}), 0)`;
const BASELINE = (w: SpendingWindows) =>
  sql<string>`coalesce(sum(${expenses.amount}) filter (where ${expenses.expenseDate} <= ${w.baselineEnd}), 0)`;

// By chart-of-accounts category. The join is what the route already did; the
// category is the operator's own COA line, so the label is one they chose.
export async function categoryMovement(
  tx: Database | Transaction,
  args: { accountId: string; companyId: string; windows: SpendingWindows },
): Promise<MovementRow[]> {
  const { accountId, companyId, windows: w } = args;
  const rows = await tx
    .select({
      key: chartOfAccounts.code,
      label: chartOfAccounts.name,
      recent: RECENT(w),
      baseline: BASELINE(w),
    })
    .from(expenses)
    .innerJoin(chartOfAccounts, eq(expenses.categoryAccountId, chartOfAccounts.id))
    .where(windowFilter(accountId, companyId, w))
    .groupBy(chartOfAccounts.id, chartOfAccounts.code, chartOfAccounts.name);
  return toMovement(rows);
}

// By merchant. Free text straight off the receipt (expenses.merchant is NOT
// NULL and is what receipt OCR writes), so this catches the case a category
// cannot: one vendor's subscription quietly doubling inside a category whose
// total barely moved.
//
// Grouped case-insensitively on the trimmed string, because "Home Depot" and
// "HOME DEPOT " off two receipts are one vendor to the person reading it. The
// label is the longest spelling seen, which reads better than an arbitrary pick.
export async function merchantMovement(
  tx: Database | Transaction,
  args: { accountId: string; companyId: string; windows: SpendingWindows },
): Promise<MovementRow[]> {
  const { accountId, companyId, windows: w } = args;
  const normalized = sql<string>`lower(btrim(${expenses.merchant}))`;
  const rows = await tx
    .select({
      key: normalized,
      label: sql<string>`(array_agg(btrim(${expenses.merchant}) order by length(btrim(${expenses.merchant})) desc))[1]`,
      recent: RECENT(w),
      baseline: BASELINE(w),
    })
    .from(expenses)
    .where(and(windowFilter(accountId, companyId, w), sql`btrim(${expenses.merchant}) <> ''`))
    // Group by ordinal, not by re-emitting the expression. The normalized
    // expression carries no bound parameter today, but the report-timezone bug
    // was exactly this shape twice over: a parameterized GROUP BY gets a
    // different parameter number than the identical text in SELECT, and
    // Postgres matches structurally. Position 1 is the key column by
    // construction.
    .groupBy(sql`1`);
  return toMovement(rows);
}

// The notable movers, for a caller that wants context rather than an alert.
// Sorted by how far above typical they are, biggest first, and filtered to
// things large enough to be worth a sentence.
//
// MIN_RECENT is a floor in dollars, not a percentage: a category going from $2
// to $6 is up 200% and is not news. The route's own spike thresholds are
// deliberately NOT applied here — a nudge naming the biggest mover is useful
// even when it has not crossed the "this is unusual" bar.
export function notableMovers(rows: MovementRow[], opts: { minRecent: number; limit: number }) {
  return rows
    .filter((r) => r.recent >= opts.minRecent && r.typical > 0)
    .map((r) => ({
      label: r.label,
      recent: r.recent.toFixed(2),
      typical: r.typical.toFixed(2),
      pctOver: Math.round((r.recent / r.typical - 1) * 100),
    }))
    .sort((a, b) => b.pctOver - a.pctOver)
    .slice(0, opts.limit);
}

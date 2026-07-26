import { createHash } from 'node:crypto';
import {
  CASH_FLOW_NUDGE_VERSION,
  type CashFlowAdvisor,
  type CashFlowSignals,
  createCashFlowAdvisor,
} from '@thalermark/ai';
import {
  bills,
  chartOfAccounts,
  companies,
  contacts,
  estimates,
  expenses,
  invoiceLineItems,
  invoices,
  items,
  journalEntries,
  journalLines,
} from '@thalermark/db';
import { centsToMoney, sumMoney, toCents } from '@thalermark/validation';
import { and, asc, eq, gte, inArray, isNull, lt, lte, ne, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { validator } from 'hono/validator';
import type { AppDeps } from '../app.js';
import { apBalance, arBalance, cashFlowNet, cashOnHand } from '../lib/ledger.js';
import { recordLlmCallHealth } from '../lib/llm-connection.js';
import { resolveAccountCredential } from '../lib/llm-credentials.js';
import { UUID_RE } from '../lib/route-helpers.js';
import { type ExpenseAccountAmount, rollUpPartII, taxYearWindow } from '../lib/schedule-c.js';
import { requireEntitlement } from '../middleware/entitlement.js';
import { RATE_LIMITS, rateLimit } from '../middleware/rate-limit.js';
import type { RlsVariables } from '../middleware/rls-context.js';

// reports — the dashboard / reports / AI-insight domain: the company-scoped
// read surface that turns the hidden ledger into the product's answers.
// Position dashboard, top products, P&L, sales-by-customer, revenue-over-time,
// estimate win rate, balance sheet, A/R aging, sales tax, plus the two AI
// insights (cash-flow nudges, spending anomalies). All GET reads off the
// ledger; the only deps user is the cash-flow advisor (deps.advisor) which
// narrates deterministic ledger signals — the nudge cache is DB-backed
// (companies.cash_flow_nudges + a CASH_FLOW_NUDGE_VERSION-tagged input hash),
// no module state. Mounted on createApp via .route() so its schema rides on its
// own ReportsAppType instead of bloating AppType past TS7056. These all live
// under /api/companies/:id/* — the company CRUD/settings half is the companies
// sub-app; extracting them here empties the /api/companies/:id prefix from
// AppType, so the facade's split-prefix intersection collapses to a plain
// override (see api.server.ts / mobile api.ts).

// Parse a from/to reporting window shared by the report endpoints. Both are
// optional; the default is year-to-date through today. Returns the half-open
// [fromDate, toExclusive) (to + 1 day, so the last day is fully included — the
// same convention as the ledger export / dashboard) plus the inclusive display
// strings; or an `error` code the caller turns into a 400. `from`/`to` are also
// suitable for direct comparison against bare `date` columns (issue_date), which
// compare inclusively on both ends.
type ReportWindow = { fromDate: Date; toExclusive: Date; from: string; to: string };
function parseReportWindow(
  fromRaw: string | undefined,
  toRaw: string | undefined,
): ReportWindow | { error: 'invalid_from' | 'invalid_to' | 'invalid_range' } {
  const now = new Date();
  let fromDate: Date;
  if (fromRaw !== undefined) {
    fromDate = new Date(`${fromRaw}T00:00:00Z`);
    if (Number.isNaN(fromDate.getTime())) return { error: 'invalid_from' };
  } else {
    fromDate = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  }
  let toExclusive: Date;
  if (toRaw !== undefined) {
    const t = new Date(`${toRaw}T00:00:00Z`);
    if (Number.isNaN(t.getTime())) return { error: 'invalid_to' };
    toExclusive = new Date(t);
  } else {
    toExclusive = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }
  toExclusive.setUTCDate(toExclusive.getUTCDate() + 1);
  if (fromDate >= toExclusive) return { error: 'invalid_range' };
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  const toInclusive = new Date(toExclusive);
  toInclusive.setUTCDate(toInclusive.getUTCDate() - 1);
  return { fromDate, toExclusive, from: ymd(fromDate), to: ymd(toInclusive) };
}

// Parse a single as-of date (YYYY-MM-DD) for point-in-time reports (balance
// sheet, A/R aging). Default is today. Returns the inclusive display string +
// the half-open upper bound (asOf + 1 day) so a balance includes everything
// posted any time on the as-of day; or an `error` for a 400.
function parseAsOf(
  raw: string | undefined,
): { asOf: string; asOfExclusive: Date } | { error: 'invalid_as_of' } {
  const now = new Date();
  let d: Date;
  if (raw !== undefined) {
    d = new Date(`${raw}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return { error: 'invalid_as_of' };
  } else {
    d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }
  const asOf = d.toISOString().slice(0, 10);
  const asOfExclusive = new Date(d);
  asOfExclusive.setUTCDate(asOfExclusive.getUTCDate() + 1);
  return { asOf, asOfExclusive };
}

// Stateless cash-flow advisor — the reasoning model is resolved per call from
// the account's credential. deps.advisor overrides it (tests inject a stub);
// otherwise the real caller is used and availability rides on the credential.
const defaultAdvisor = createCashFlowAdvisor();

export function reportsRoutes(deps: AppDeps) {
  return (
    new Hono<{ Variables: RlsVariables }>()
      // Position dashboard (slice 8.10). The product's answer surface: money
      // in, money out, what's owed — read straight off the ledger (the payoff
      // of the L1–L4 reshape). `money in/out` is cash movement over a window
      // (debits / credits on cash-like asset accounts — every asset except AR,
      // since an invoice being *sent* debits AR but that isn't cash in hand);
      // `owed` is the live AR balance, point-in-time, not period-bound. Cash
      // basis, UTC window (a per-tenant timezone is a later refinement).
      .get(
        '/api/companies/:id/dashboard',
        validator('query', (v) => ({
          period: typeof v.period === 'string' ? v.period : undefined,
          from: typeof v.from === 'string' ? v.from : undefined,
          to: typeof v.to === 'string' ? v.to : undefined,
        })),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);

          const tx = c.get('tx');
          const accountId = c.get('accountId');

          const [company] = await tx
            .select({ id: companies.id })
            .from(companies)
            .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
            .limit(1);
          if (!company) return c.json({ error: 'company_not_found' }, 404);

          // Window for the in/out flows. Explicit from/to wins (L4-style, for
          // deterministic callers + tests); otherwise a named period, default
          // this month. Upper bound is half-open on the day after `to` so the
          // last day is fully included (matches the ledger export).
          const { period: periodRaw, from: fromRaw, to: toRaw } = c.req.valid('query');
          const period = periodRaw ?? 'month';
          let fromDate: Date;
          let toExclusive: Date;
          if (fromRaw !== undefined || toRaw !== undefined) {
            const f = fromRaw ? new Date(`${fromRaw}T00:00:00Z`) : null;
            const t = toRaw ? new Date(`${toRaw}T00:00:00Z`) : null;
            if (!f || Number.isNaN(f.getTime())) return c.json({ error: 'invalid_from' }, 400);
            if (!t || Number.isNaN(t.getTime())) return c.json({ error: 'invalid_to' }, 400);
            if (f > t) return c.json({ error: 'invalid_range' }, 400);
            fromDate = f;
            toExclusive = new Date(t);
            toExclusive.setUTCDate(toExclusive.getUTCDate() + 1);
          } else {
            const now = new Date();
            const y = now.getUTCFullYear();
            const m = now.getUTCMonth();
            const d = now.getUTCDate();
            toExclusive = new Date(Date.UTC(y, m, d + 1));
            if (period === 'month') {
              fromDate = new Date(Date.UTC(y, m, 1));
            } else if (period === '30d') {
              fromDate = new Date(Date.UTC(y, m, d - 29));
            } else if (period === 'ytd') {
              fromDate = new Date(Date.UTC(y, 0, 1));
            } else {
              return c.json({ error: 'invalid_period' }, 400);
            }
          }

          // Reversal-safe cash flow + live AR balance (shared with cash-flow
          // nudges) — see cashFlowNet / arBalance in lib/ledger.ts. Netting per
          // source means expense edits/voids don't inflate the flows (#144).
          const cash = await cashFlowNet(tx, { accountId, companyId: id, fromDate, toExclusive });
          const owed = await arBalance(tx, { accountId, companyId: id });
          // `owing` completes the in/out/owed/owing quadrant — the live AP
          // balance (what's owed to vendors via open bills), point-in-time like
          // `owed`. Zero until the first bill is recorded.
          const owing = await apBalance(tx, { accountId, companyId: id });

          // Inclusive display window (the day before the half-open upper bound).
          const toInclusive = new Date(toExclusive);
          toInclusive.setUTCDate(toInclusive.getUTCDate() - 1);
          const ymd = (dt: Date) => dt.toISOString().slice(0, 10);

          return c.json({
            moneyIn: cash.moneyIn,
            moneyOut: cash.moneyOut,
            owed,
            owing,
            from: ymd(fromDate),
            to: ymd(toInclusive),
          });
        },
      )
      // Top-products report (slice I5) — the payoff of the source_item_id
      // breadcrumb. A deterministic GROUP BY source_item_id aggregate over
      // invoice line items (SUM(amount), COUNT(*)); no second datastore. This
      // is a management/sales lens, explicitly NOT GL-reconciled: line amounts
      // are pre-tax, and a single "Uncatalogued / other" bucket (NULL-source
      // lines, identified by sourceItemId === null) collects hand-typed lines
      // so product rows + the bucket tie back to GL revenue on a matched basis.
      // `basis` states what counts: 'paid' (cash — paid invoices only, the
      // default) or 'sent' (sent or paid, voided/draft excluded). Archived
      // items keep their name via the left join, so the report never loses
      // history. Catalogued rows sort by revenue desc; the bucket sorts last.
      .get(
        '/api/companies/:id/top-products',
        // validator types `query` for the hc<AppType>() client (same reason as
        // the dashboard route) and rejects an unknown basis with a clean 400.
        validator('query', (v, c) => {
          const basis = v.basis;
          if (basis !== undefined && basis !== 'paid' && basis !== 'sent') {
            return c.json({ error: 'invalid_basis' }, 400);
          }
          return { basis: (basis ?? 'paid') as 'paid' | 'sent' };
        }),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);

          const { basis } = c.req.valid('query');

          const tx = c.get('tx');
          const accountId = c.get('accountId');

          const [company] = await tx
            .select({ id: companies.id })
            .from(companies)
            .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
            .limit(1);
          if (!company) return c.json({ error: 'company_not_found' }, 404);

          const statusFilter =
            basis === 'paid'
              ? eq(invoices.status, 'paid')
              : inArray(invoices.status, ['sent', 'paid']);

          const rows = await tx
            .select({
              sourceItemId: invoiceLineItems.sourceItemId,
              name: items.name,
              revenue: sql<string>`sum(${invoiceLineItems.amount})::numeric(15,2)`,
              lineCount: sql<number>`count(*)::int`,
            })
            .from(invoiceLineItems)
            .innerJoin(invoices, eq(invoices.id, invoiceLineItems.invoiceId))
            .leftJoin(items, eq(items.id, invoiceLineItems.sourceItemId))
            .where(
              and(
                eq(invoiceLineItems.accountId, accountId),
                eq(invoices.accountId, accountId),
                eq(invoices.companyId, id),
                statusFilter,
              ),
            )
            .groupBy(invoiceLineItems.sourceItemId, items.name)
            // Uncatalogued bucket (null source) sorts last; products by revenue.
            .orderBy(
              sql`(${invoiceLineItems.sourceItemId} is null) asc, sum(${invoiceLineItems.amount}) desc`,
            );

          const mapped = rows.map((r) => ({
            sourceItemId: r.sourceItemId,
            name: r.name,
            revenue: r.revenue ?? '0.00',
            lineCount: r.lineCount,
          }));
          // Top 25 catalogued products by revenue, plus the single
          // "Uncatalogued / other" bucket (hand-typed lines) appended as
          // context — it's an "other" row, not a product, so it doesn't consume
          // a slot in the top 25. Slicing in app code (rows are already ordered
          // products-first, bucket-last) keeps the bucket regardless of how many
          // products there are; a bare LIMIT would drop it.
          const TOP_N = 25;
          const products = mapped.filter((p) => p.sourceItemId !== null).slice(0, TOP_N);
          const bucket = mapped.filter((p) => p.sourceItemId === null);
          return c.json({ basis, products: [...products, ...bucket] });
        },
      )
      // Profit & Loss report (the tax set). Accrual income statement read
      // straight off the GL: revenue + expense accounts, summed in their
      // normal-balance direction over a [from, to] window (inclusive, to+1 day
      // exclusive on the upper bound — same convention as the ledger export and
      // dashboard). Default window is year-to-date. Each account's signed net
      // (per-account window sum) is reversal-safe by construction: a void/edit
      // posts a reversing entry that flips the sign, so an in-window correction
      // nets out and a cross-period one lands in the period it was posted (real
      // accrual behavior) — no per-source netting like cashFlowNet needs.
      // taxMapping (Schedule C line) rides along so the expense breakdown
      // doubles as a tax-prep view. Powers both /reports/profit-and-loss and
      // /reports/expenses-by-category (the expense section).
      .get(
        '/api/companies/:id/profit-loss',
        validator('query', (v) => ({
          from: typeof v.from === 'string' ? v.from : undefined,
          to: typeof v.to === 'string' ? v.to : undefined,
        })),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);

          const tx = c.get('tx');
          const accountId = c.get('accountId');

          const [company] = await tx
            .select({ id: companies.id })
            .from(companies)
            .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
            .limit(1);
          if (!company) return c.json({ error: 'company_not_found' }, 404);

          const { from: fromRaw, to: toRaw } = c.req.valid('query');
          const win = parseReportWindow(fromRaw, toRaw);
          if ('error' in win) return c.json({ error: win.error }, 400);
          const { fromDate, toExclusive, from, to } = win;

          // Per-account net in the account's normal-balance direction: when a
          // line's side matches the account's normal_balance it adds, else it
          // subtracts. Revenue (credit-normal) => credit−debit; expense
          // (debit-normal) => debit−credit.
          const rows = await tx
            .select({
              code: chartOfAccounts.code,
              name: chartOfAccounts.name,
              accountType: chartOfAccounts.accountType,
              taxMapping: chartOfAccounts.taxMapping,
              amount: sql<string>`sum(case when ${journalLines.side} = ${chartOfAccounts.normalBalance} then ${journalLines.amount} else -${journalLines.amount} end)::numeric(15,2)`,
            })
            .from(journalLines)
            .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
            .innerJoin(chartOfAccounts, eq(journalLines.coaAccountId, chartOfAccounts.id))
            .where(
              and(
                eq(journalEntries.companyId, id),
                eq(journalEntries.accountId, accountId),
                inArray(chartOfAccounts.accountType, ['revenue', 'expense']),
                gte(journalEntries.postedAt, fromDate),
                lt(journalEntries.postedAt, toExclusive),
              ),
            )
            .groupBy(
              chartOfAccounts.code,
              chartOfAccounts.name,
              chartOfAccounts.accountType,
              chartOfAccounts.taxMapping,
            )
            .orderBy(asc(chartOfAccounts.code));

          type Line = { code: string; name: string; taxMapping: string | null; amount: string };
          const revenue: Line[] = [];
          const expenses: Line[] = [];
          let totalRevenueCents = 0;
          let totalExpensesCents = 0;
          for (const r of rows) {
            const amtCents = toCents(r.amount);
            // Drop accounts that net to zero in the window (e.g. a sale fully
            // voided in-period) so the statement isn't cluttered with no-ops.
            if (amtCents === 0) continue;
            const line: Line = {
              code: r.code,
              name: r.name,
              taxMapping: r.taxMapping,
              amount: r.amount,
            };
            if (r.accountType === 'revenue') {
              revenue.push(line);
              totalRevenueCents += amtCents;
            } else {
              expenses.push(line);
              totalExpensesCents += amtCents;
            }
          }

          return c.json({
            from,
            to,
            revenue,
            expenses,
            totalRevenue: centsToMoney(totalRevenueCents),
            totalExpenses: centsToMoney(totalExpensesCents),
            netProfit: centsToMoney(totalRevenueCents - totalExpensesCents),
          });
        },
      )
      // Schedule C worksheet (TMC-155) — the accountant handoff. Not a filing:
      // a form-shaped view the user hands over or types into consumer tax
      // software. The COA already carries the mapping (chart_of_accounts
      // .tax_mapping, seeded per account), so this groups by tax line instead
      // of by account code and fills the rest of the form's skeleton.
      //
      // Basis is the interesting part. The GL is *always* accrual — that's what
      // double-entry is — so cash basis is a reporting lens applied at read
      // time, the same one-ledger model QuickBooks and Xero use. Defaults to
      // the company's accounting_method (itself defaulting to cash, which is
      // how effectively every sole proprietor files); ?basis= overrides for a
      // side-by-side look without changing the stored election.
      //
      //   accrual — read straight off the GL, same query shape as profit-loss.
      //   cash    — gross receipts from invoices actually PAID in the window
      //             (direct method: query what was paid, rather than the
      //             textbook indirect "accrual revenue − ΔAR"; our invoice-level
      //             paid state is clean, so this is the more accurate of the
      //             two). Expenses already post Dr expense / Cr cash at spend
      //             time, so they're cash-basis already — except bills, which
      //             post Dr expense / Cr AP when *opened*. So we drop
      //             bill-sourced GL postings and add back bills paid in-window
      //             against their original category.
      .get(
        '/api/companies/:id/schedule-c',
        validator('query', (v) => {
          const basis = v.basis;
          if (basis !== undefined && basis !== 'cash' && basis !== 'accrual') {
            return { error: 'invalid_basis' as const };
          }
          const yearRaw = v.year;
          let year: number | undefined;
          if (typeof yearRaw === 'string') {
            year = Number(yearRaw);
            // A tax year outside this range is a typo, not a filing. Bounding it
            // also keeps taxYearWindow from building nonsense Dates.
            if (!Number.isInteger(year) || year < 1900 || year > 2200) {
              return { error: 'invalid_year' as const };
            }
          }
          return { basis: basis as 'cash' | 'accrual' | undefined, year };
        }),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);

          const q = c.req.valid('query');
          if ('error' in q) return c.json({ error: q.error }, 400);

          const tx = c.get('tx');
          const accountId = c.get('accountId');

          // accounting_method rides along on the company lookup — it's the
          // basis default, so we'd need the row either way.
          const [company] = await tx
            .select({ id: companies.id, accountingMethod: companies.accountingMethod })
            .from(companies)
            .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
            .limit(1);
          if (!company) return c.json({ error: 'company_not_found' }, 404);

          const basis = q.basis ?? (company.accountingMethod === 'accrual' ? 'accrual' : 'cash');
          const year = q.year ?? new Date().getUTCFullYear();
          const { from, to, fromDate, toExclusive } = taxYearWindow(year);

          // Per-account net in the account's normal-balance direction, same
          // convention as profit-loss: a line on the account's normal side adds,
          // the other side subtracts. Reversal-safe by construction.
          //
          // coalesce matters: the revenue query below has no GROUP BY, so over
          // an empty window Postgres returns a single row with a NULL sum rather
          // than zero rows — and a null would reach toCents.
          const glAmount = sql<string>`coalesce(sum(case when ${journalLines.side} = ${chartOfAccounts.normalBalance} then ${journalLines.amount} else -${journalLines.amount} end), 0)::numeric(15,2)`;

          const glExpenseFilters = [
            eq(journalEntries.companyId, id),
            eq(journalEntries.accountId, accountId),
            eq(chartOfAccounts.accountType, 'expense'),
            gte(journalEntries.postedAt, fromDate),
            lt(journalEntries.postedAt, toExclusive),
          ];
          // Cash basis: a bill's expense belongs to the period the bill was
          // PAID, not opened. Both legs of a bill (open, and any void reversal)
          // carry source_entity_type 'bill', so excluding the source wholesale
          // keeps reversals consistent, and the paid-bill query below re-adds
          // the cash-basis amount at the right date.
          if (basis === 'cash') {
            glExpenseFilters.push(ne(journalEntries.sourceEntityType, 'bill'));
          }

          const expenseRows = await tx
            .select({
              code: chartOfAccounts.code,
              name: chartOfAccounts.name,
              taxMapping: chartOfAccounts.taxMapping,
              amount: glAmount,
            })
            .from(journalLines)
            .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
            .innerJoin(chartOfAccounts, eq(journalLines.coaAccountId, chartOfAccounts.id))
            .where(and(...glExpenseFilters))
            .groupBy(chartOfAccounts.code, chartOfAccounts.name, chartOfAccounts.taxMapping)
            .orderBy(asc(chartOfAccounts.code));

          // Merge on account code so a category that received both a direct
          // expense and a paid bill lands on one Part II row.
          const expenseByCode = new Map<string, ExpenseAccountAmount>();
          const addExpense = (row: ExpenseAccountAmount) => {
            const existing = expenseByCode.get(row.code);
            if (!existing) {
              expenseByCode.set(row.code, { ...row });
              return;
            }
            existing.amount = centsToMoney(toCents(existing.amount) + toCents(row.amount));
          };
          for (const row of expenseRows) addExpense(row);

          if (basis === 'cash') {
            const paidBills = await tx
              .select({
                code: chartOfAccounts.code,
                name: chartOfAccounts.name,
                taxMapping: chartOfAccounts.taxMapping,
                amount: sql<string>`coalesce(sum(${bills.amount}), 0)::numeric(15,2)`,
              })
              .from(bills)
              .innerJoin(chartOfAccounts, eq(bills.categoryAccountId, chartOfAccounts.id))
              .where(
                and(
                  eq(bills.accountId, accountId),
                  eq(bills.companyId, id),
                  eq(bills.status, 'paid'),
                  gte(bills.paidAt, fromDate),
                  lt(bills.paidAt, toExclusive),
                ),
              )
              .groupBy(chartOfAccounts.code, chartOfAccounts.name, chartOfAccounts.taxMapping)
              .orderBy(asc(chartOfAccounts.code));
            for (const row of paidBills) addExpense(row);
          }

          const partII = rollUpPartII([...expenseByCode.values()]);

          // Gross receipts (line 1).
          let grossReceiptsCents: number;
          if (basis === 'cash') {
            // Direct method, and deliberately off the GL: summing cash debits
            // would also sweep in owner contributions and loan proceeds, which
            // are cash in but not revenue. Querying invoices excludes them
            // structurally rather than by blocklist. subtotal is pre-tax —
            // sales tax collected is not income. Safe against later edits
            // because 'paid' is a terminal status, so a filed year can't be
            // retroactively altered.
            //
            // NOTE: this assumes payment is all-or-nothing (there is no partial
            // payment or deposit model today). If deposits land, this silently
            // becomes wrong — it must move to a payments table at that point.
            const [row] = await tx
              .select({
                gross: sql<string>`coalesce(sum(${invoices.subtotal}), 0)::numeric(15,2)`,
              })
              .from(invoices)
              .where(
                and(
                  eq(invoices.accountId, accountId),
                  eq(invoices.companyId, id),
                  eq(invoices.status, 'paid'),
                  gte(invoices.paidAt, fromDate),
                  lt(invoices.paidAt, toExclusive),
                ),
              );
            grossReceiptsCents = toCents(row?.gross ?? '0.00');
          } else {
            const revenueRows = await tx
              .select({ amount: glAmount })
              .from(journalLines)
              .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
              .innerJoin(chartOfAccounts, eq(journalLines.coaAccountId, chartOfAccounts.id))
              .where(
                and(
                  eq(journalEntries.companyId, id),
                  eq(journalEntries.accountId, accountId),
                  eq(chartOfAccounts.accountType, 'revenue'),
                  gte(journalEntries.postedAt, fromDate),
                  lt(journalEntries.postedAt, toExclusive),
                ),
              );
            grossReceiptsCents = revenueRows.reduce((sum, r) => sum + toCents(r.amount), 0);
          }

          // Part I. Returns/allowances (2), COGS (4) and other income (6) have
          // no data model — no refunds, no inventory (the seed routes materials
          // to Supplies, line 22, matching Wave's sole-prop default). They're
          // emitted at zero rather than omitted so the form reads whole.
          const totalExpensesCents = toCents(partII.totalExpenses);
          const tentativeProfitCents = grossReceiptsCents - totalExpensesCents;

          return c.json({
            year,
            basis,
            // Lets the UI say "showing accrual, your saved method is cash"
            // instead of silently disagreeing with Settings.
            companyAccountingMethod: company.accountingMethod,
            from,
            to,
            partI: {
              grossReceipts: centsToMoney(grossReceiptsCents),
              returnsAndAllowances: '0.00',
              netReceipts: centsToMoney(grossReceiptsCents),
              costOfGoodsSold: '0.00',
              grossProfit: centsToMoney(grossReceiptsCents),
              otherIncome: '0.00',
              grossIncome: centsToMoney(grossReceiptsCents),
            },
            partII: partII.rows,
            unmappedExpenses: partII.unmapped,
            totalExpenses: partII.totalExpenses,
            tentativeProfit: centsToMoney(tentativeProfitCents),
            // Line 30 (business use of home) has no data model. Explicitly null
            // rather than 0.00 so the UI renders "you must supply this" — a
            // silent zero would read as "you have no home office".
            homeOffice: null,
            // Line 31. Excludes line 30 by construction; the UI has to say so.
            netProfit: centsToMoney(tentativeProfitCents),
          });
        },
      )
      // Sales by customer (insight set). Pre-tax sales (subtotal) per customer
      // for invoices issued in the window, sent or paid (drafts + voided
      // excluded). Top 25 by sales; the grand total sums ALL contacts (computed
      // from the full result, sliced in app code) so "Top 25 of $X" is honest.
      .get(
        '/api/companies/:id/sales-by-customer',
        validator('query', (v) => ({
          from: typeof v.from === 'string' ? v.from : undefined,
          to: typeof v.to === 'string' ? v.to : undefined,
        })),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
          const tx = c.get('tx');
          const accountId = c.get('accountId');
          const [company] = await tx
            .select({ id: companies.id })
            .from(companies)
            .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
            .limit(1);
          if (!company) return c.json({ error: 'company_not_found' }, 404);

          const { from: fromRaw, to: toRaw } = c.req.valid('query');
          const win = parseReportWindow(fromRaw, toRaw);
          if ('error' in win) return c.json({ error: win.error }, 400);

          const rows = await tx
            .select({
              contactId: invoices.contactId,
              name: contacts.name,
              sales: sql<string>`sum(${invoices.subtotal})::numeric(15,2)`,
              invoiceCount: sql<number>`count(*)::int`,
            })
            .from(invoices)
            .leftJoin(contacts, eq(contacts.id, invoices.contactId))
            .where(
              and(
                eq(invoices.accountId, accountId),
                eq(invoices.companyId, id),
                inArray(invoices.status, ['sent', 'paid']),
                gte(invoices.issueDate, win.from),
                lte(invoices.issueDate, win.to),
              ),
            )
            .groupBy(invoices.contactId, contacts.name)
            .orderBy(sql`sum(${invoices.subtotal}) desc`);

          const totalSales = sumMoney(rows.map((r) => r.sales ?? '0'));
          return c.json({
            from: win.from,
            to: win.to,
            contacts: rows.slice(0, 25).map((r) => ({
              contactId: r.contactId,
              name: r.name,
              sales: r.sales ?? '0.00',
              invoiceCount: r.invoiceCount,
            })),
            totalSales,
          });
        },
      )
      // Revenue over time (insight set). Pre-tax sales per calendar month for
      // invoices issued in the window, sent or paid. Months with no sales are
      // simply absent (the web page fills the gaps for a continuous trend).
      .get(
        '/api/companies/:id/revenue-over-time',
        validator('query', (v) => ({
          from: typeof v.from === 'string' ? v.from : undefined,
          to: typeof v.to === 'string' ? v.to : undefined,
        })),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
          const tx = c.get('tx');
          const accountId = c.get('accountId');
          const [company] = await tx
            .select({ id: companies.id })
            .from(companies)
            .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
            .limit(1);
          if (!company) return c.json({ error: 'company_not_found' }, 404);

          const { from: fromRaw, to: toRaw } = c.req.valid('query');
          const win = parseReportWindow(fromRaw, toRaw);
          if ('error' in win) return c.json({ error: win.error }, 400);

          const monthExpr = sql<string>`to_char(date_trunc('month', ${invoices.issueDate}::date), 'YYYY-MM')`;
          const rows = await tx
            .select({
              month: monthExpr,
              revenue: sql<string>`sum(${invoices.subtotal})::numeric(15,2)`,
            })
            .from(invoices)
            .where(
              and(
                eq(invoices.accountId, accountId),
                eq(invoices.companyId, id),
                inArray(invoices.status, ['sent', 'paid']),
                gte(invoices.issueDate, win.from),
                lte(invoices.issueDate, win.to),
              ),
            )
            .groupBy(monthExpr)
            .orderBy(monthExpr);

          const total = sumMoney(rows.map((r) => r.revenue ?? '0'));
          return c.json({
            from: win.from,
            to: win.to,
            months: rows.map((r) => ({ month: r.month, revenue: r.revenue ?? '0.00' })),
            total,
          });
        },
      )
      // Estimate win rate (insight set). Estimate counts + pre-tax value grouped
      // by status for estimates issued in the window. Win rate = accepted /
      // (accepted + declined + expired) by count — "decided" excludes still-open
      // draft/sent. Null when nothing has been decided yet.
      .get(
        '/api/companies/:id/estimate-win-rate',
        validator('query', (v) => ({
          from: typeof v.from === 'string' ? v.from : undefined,
          to: typeof v.to === 'string' ? v.to : undefined,
        })),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
          const tx = c.get('tx');
          const accountId = c.get('accountId');
          const [company] = await tx
            .select({ id: companies.id })
            .from(companies)
            .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
            .limit(1);
          if (!company) return c.json({ error: 'company_not_found' }, 404);

          const { from: fromRaw, to: toRaw } = c.req.valid('query');
          const win = parseReportWindow(fromRaw, toRaw);
          if ('error' in win) return c.json({ error: win.error }, 400);

          const rows = await tx
            .select({
              status: estimates.status,
              count: sql<number>`count(*)::int`,
              value: sql<string>`sum(${estimates.subtotal})::numeric(15,2)`,
            })
            .from(estimates)
            .where(
              and(
                eq(estimates.accountId, accountId),
                eq(estimates.companyId, id),
                gte(estimates.issueDate, win.from),
                lte(estimates.issueDate, win.to),
              ),
            )
            .groupBy(estimates.status);

          // Normalize to a fixed status set (zeros for absent statuses) so the
          // page renders consistently.
          const STATUSES = ['draft', 'sent', 'accepted', 'declined', 'expired'] as const;
          const byCode = new Map(rows.map((r) => [r.status, r]));
          const byStatus = STATUSES.map((status) => {
            const row = byCode.get(status);
            return { status, count: row?.count ?? 0, value: row?.value ?? '0.00' };
          });
          const countFor = (s: string) => byStatus.find((b) => b.status === s)?.count ?? 0;
          const accepted = countFor('accepted');
          const decided = accepted + countFor('declined') + countFor('expired');
          return c.json({
            from: win.from,
            to: win.to,
            byStatus,
            acceptedCount: accepted,
            decidedCount: decided,
            // 4-dp ratio (e.g. "0.6667"); null when nothing decided yet.
            winRate: decided > 0 ? (accepted / decided).toFixed(4) : null,
          });
        },
      )
      // Balance sheet (the other primary financial statement, paired with P&L).
      // Point-in-time: every account's signed balance as of a date. The books
      // are never closed, so revenue − expenses through the as-of date is folded
      // into equity as a "Retained earnings" line — that's what makes
      // Assets = Liabilities + Equity hold (it follows directly from the trial
      // balance always balancing: Assets+Expenses = Liabilities+Equity+Revenue).
      .get(
        '/api/companies/:id/balance-sheet',
        validator('query', (v) => ({ asOf: typeof v.asOf === 'string' ? v.asOf : undefined })),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
          const tx = c.get('tx');
          const accountId = c.get('accountId');
          const [company] = await tx
            .select({ id: companies.id })
            .from(companies)
            .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
            .limit(1);
          if (!company) return c.json({ error: 'company_not_found' }, 404);

          const parsed = parseAsOf(c.req.valid('query').asOf);
          if ('error' in parsed) return c.json({ error: parsed.error }, 400);
          const { asOf, asOfExclusive } = parsed;

          const rows = await tx
            .select({
              code: chartOfAccounts.code,
              name: chartOfAccounts.name,
              accountType: chartOfAccounts.accountType,
              amount: sql<string>`sum(case when ${journalLines.side} = ${chartOfAccounts.normalBalance} then ${journalLines.amount} else -${journalLines.amount} end)::numeric(15,2)`,
            })
            .from(journalLines)
            .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
            .innerJoin(chartOfAccounts, eq(journalLines.coaAccountId, chartOfAccounts.id))
            .where(
              and(
                eq(journalEntries.companyId, id),
                eq(journalEntries.accountId, accountId),
                lt(journalEntries.postedAt, asOfExclusive),
              ),
            )
            .groupBy(chartOfAccounts.code, chartOfAccounts.name, chartOfAccounts.accountType)
            .orderBy(asc(chartOfAccounts.code));

          type Line = { code: string; name: string; amount: string };
          const assets: Line[] = [];
          const liabilities: Line[] = [];
          const equity: Line[] = [];
          let totalAssetsCents = 0;
          let totalLiabilitiesCents = 0;
          let equitySumCents = 0;
          let revenueSumCents = 0;
          let expenseSumCents = 0;
          for (const r of rows) {
            const amtCents = toCents(r.amount);
            if (amtCents === 0) continue;
            const line: Line = { code: r.code, name: r.name, amount: r.amount };
            if (r.accountType === 'asset') {
              assets.push(line);
              totalAssetsCents += amtCents;
            } else if (r.accountType === 'liability') {
              liabilities.push(line);
              totalLiabilitiesCents += amtCents;
            } else if (r.accountType === 'equity') {
              equity.push(line);
              equitySumCents += amtCents;
            } else if (r.accountType === 'revenue') {
              revenueSumCents += amtCents;
            } else {
              expenseSumCents += amtCents;
            }
          }
          // Net income (retained earnings while the books stay open) closes the
          // identity: Assets = Liabilities + (explicit equity + net income).
          const netIncomeCents = revenueSumCents - expenseSumCents;
          const totalEquityCents = equitySumCents + netIncomeCents;
          const totalLiabilitiesAndEquityCents = totalLiabilitiesCents + totalEquityCents;
          return c.json({
            asOf,
            assets,
            liabilities,
            equity,
            netIncome: centsToMoney(netIncomeCents),
            totalAssets: centsToMoney(totalAssetsCents),
            totalLiabilities: centsToMoney(totalLiabilitiesCents),
            totalEquity: centsToMoney(totalEquityCents),
            totalLiabilitiesAndEquity: centsToMoney(totalLiabilitiesAndEquityCents),
            // True by construction (every entry balances); surfaced as an
            // integrity check — a false here means the ledger has drifted. Exact
            // in the cents domain, so this is a strict equality, not an epsilon.
            balanced: totalAssetsCents === totalLiabilitiesAndEquityCents,
          });
        },
      )
      // A/R aging (getting-paid set). Currently-outstanding invoices (status
      // 'sent' — issued but unpaid; no partial payments in MVP, so the owed
      // amount is the invoice total) bucketed by days past due relative to the
      // as-of date. The total ties to the AR ledger balance.
      .get(
        '/api/companies/:id/ar-aging',
        validator('query', (v) => ({ asOf: typeof v.asOf === 'string' ? v.asOf : undefined })),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
          const tx = c.get('tx');
          const accountId = c.get('accountId');
          const [company] = await tx
            .select({ id: companies.id })
            .from(companies)
            .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
            .limit(1);
          if (!company) return c.json({ error: 'company_not_found' }, 404);

          const parsed = parseAsOf(c.req.valid('query').asOf);
          if ('error' in parsed) return c.json({ error: parsed.error }, 400);
          const { asOf } = parsed;

          const rows = await tx
            .select({
              id: invoices.id,
              number: invoices.number,
              customerName: contacts.name,
              dueDate: invoices.dueDate,
              total: invoices.total,
            })
            .from(invoices)
            .leftJoin(contacts, eq(contacts.id, invoices.contactId))
            .where(
              and(
                eq(invoices.accountId, accountId),
                eq(invoices.companyId, id),
                eq(invoices.status, 'sent'),
              ),
            );

          // Days past due = asOf − dueDate (both bare dates, UTC midnight). A
          // negative value = not yet due → the "current" bucket.
          const asOfMs = new Date(`${asOf}T00:00:00Z`).getTime();
          const BUCKETS = [
            { key: 'current', label: 'Current', min: Number.NEGATIVE_INFINITY, max: 0 },
            { key: '1-30', label: '1–30 days', min: 1, max: 30 },
            { key: '31-60', label: '31–60 days', min: 31, max: 60 },
            { key: '61-90', label: '61–90 days', min: 61, max: 90 },
            { key: '90+', label: '90+ days', min: 91, max: Number.POSITIVE_INFINITY },
          ];
          // amount is accumulated in integer cents (formatted on the way out).
          const bucketTotals = new Map(BUCKETS.map((b) => [b.key, { count: 0, amountCents: 0 }]));
          const outstanding = rows
            .map((r) => {
              const dueMs = new Date(`${r.dueDate}T00:00:00Z`).getTime();
              const daysPastDue = Math.round((asOfMs - dueMs) / 86_400_000);
              const bucket = BUCKETS.find((b) => daysPastDue >= b.min && daysPastDue <= b.max);
              const key = bucket?.key ?? 'current';
              const agg = bucketTotals.get(key);
              if (agg) {
                agg.count += 1;
                agg.amountCents += toCents(r.total);
              }
              return {
                id: r.id,
                number: r.number,
                customerName: r.customerName,
                dueDate: r.dueDate,
                daysPastDue,
                amount: r.total,
              };
            })
            // Most overdue first.
            .sort((a, b) => b.daysPastDue - a.daysPastDue);

          const total = sumMoney(outstanding.map((r) => r.amount));
          return c.json({
            asOf,
            buckets: BUCKETS.map((b) => {
              const agg = bucketTotals.get(b.key);
              return {
                key: b.key,
                label: b.label,
                count: agg?.count ?? 0,
                amount: centsToMoney(agg?.amountCents ?? 0),
              };
            }),
            invoices: outstanding,
            total,
          });
        },
      )
      // Sales tax collected (getting-paid set). Net movement on Sales Tax
      // Payable (COA 2200, per SOLE_PROP_COA) over the window — sent invoices
      // credit it, voids debit it, so credit−debit is tax owed to the state for
      // the period. Bucketed by the month the posting landed (mark-sent time).
      .get(
        '/api/companies/:id/sales-tax',
        validator('query', (v) => ({
          from: typeof v.from === 'string' ? v.from : undefined,
          to: typeof v.to === 'string' ? v.to : undefined,
        })),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
          const tx = c.get('tx');
          const accountId = c.get('accountId');
          const [company] = await tx
            .select({ id: companies.id })
            .from(companies)
            .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
            .limit(1);
          if (!company) return c.json({ error: 'company_not_found' }, 404);

          const { from: fromRaw, to: toRaw } = c.req.valid('query');
          const win = parseReportWindow(fromRaw, toRaw);
          if ('error' in win) return c.json({ error: win.error }, 400);

          const monthExpr = sql<string>`to_char(date_trunc('month', ${journalEntries.postedAt}), 'YYYY-MM')`;
          const rows = await tx
            .select({
              month: monthExpr,
              collected: sql<string>`sum(case when ${journalLines.side} = 'credit' then ${journalLines.amount} else -${journalLines.amount} end)::numeric(15,2)`,
            })
            .from(journalLines)
            .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
            .innerJoin(chartOfAccounts, eq(journalLines.coaAccountId, chartOfAccounts.id))
            .where(
              and(
                eq(journalEntries.companyId, id),
                eq(journalEntries.accountId, accountId),
                eq(chartOfAccounts.code, '2200'),
                gte(journalEntries.postedAt, win.fromDate),
                lt(journalEntries.postedAt, win.toExclusive),
              ),
            )
            .groupBy(monthExpr)
            .orderBy(monthExpr);

          const total = centsToMoney(rows.reduce((s, r) => s + toCents(r.collected ?? '0'), 0));
          return c.json({
            from: win.from,
            to: win.to,
            months: rows.map((r) => ({ month: r.month, collected: r.collected ?? '0.00' })),
            total,
          });
        },
      )
      // Cash-flow nudges (AI insight). Deterministic ledger signals computed
      // here (the LLM never does ledger arithmetic); the reasoning-model
      // advisor only narrates them into <=3 plain-English nudges. Cached on the
      // company row + regenerated only when the signals' hash changes (new
      // activity, a newly-overdue invoice, a month rollover) — so a quiet
      // dashboard reload returns the cached text with no model call. Opt-in
      // like the other AI routes: 503 only when there's no advisor AND nothing
      // cached. The cache write on a GET is deliberate read-through memoisation.
      .get(
        '/api/companies/:id/cash-flow-nudges',
        requireEntitlement(deps, 'ai'),
        rateLimit(deps, RATE_LIMITS.ai, (c) => c.get('accountId') as string | undefined),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);

          const accountId = c.get('accountId');
          // This account's LLM credential (managed or its own BYOK key). Resolved
          // but not gated yet: a cache hit below serves cached nudges even with no
          // usable key; only a cache MISS with no credential 503s.
          const credential = await resolveAccountCredential(deps, accountId);

          // tx1: load the cache + compute the deterministic ledger signals, then
          // release the connection before the model call (deferred-tx route, see
          // rls-context).
          const prep = await c.var.runInTx(async (tx) => {
            const [company] = await tx
              .select({
                id: companies.id,
                cachedNudges: companies.cashFlowNudges,
                cachedHash: companies.nudgesInputHash,
                generatedAt: companies.nudgesGeneratedAt,
              })
              .from(companies)
              .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
              .limit(1);
            if (!company) return null;

            // Window math (UTC, half-open upper bounds). MTD = month start → tomorrow;
            // trailing = the 3 prior full calendar months (Date.UTC handles year
            // underflow). overdue = sent invoices whose due date has passed.
            const now = new Date();
            const y = now.getUTCFullYear();
            const m = now.getUTCMonth();
            const d = now.getUTCDate();
            const todayYmd = now.toISOString().slice(0, 10);
            const monthStart = new Date(Date.UTC(y, m, 1));
            const tomorrow = new Date(Date.UTC(y, m, d + 1));

            const scope = { accountId, companyId: id };
            const monthToDate = await cashFlowNet(tx, {
              ...scope,
              fromDate: monthStart,
              toExclusive: tomorrow,
            });
            const trailingMonths: CashFlowSignals['trailingMonths'] = [];
            for (let k = 3; k >= 1; k--) {
              const start = new Date(Date.UTC(y, m - k, 1));
              const end = new Date(Date.UTC(y, m - k + 1, 1));
              const flow = await cashFlowNet(tx, { ...scope, fromDate: start, toExclusive: end });
              trailingMonths.push({
                month: start.toISOString().slice(0, 7),
                moneyIn: flow.moneyIn,
                moneyOut: flow.moneyOut,
              });
            }
            const [overdue] = await tx
              .select({ count: sql<number>`count(*)::int` })
              .from(invoices)
              .where(
                and(
                  eq(invoices.accountId, accountId),
                  eq(invoices.companyId, id),
                  eq(invoices.status, 'sent'),
                  lt(invoices.dueDate, todayYmd),
                ),
              );

            const signals: CashFlowSignals = {
              asOf: todayYmd,
              cashOnHand: await cashOnHand(tx, scope),
              monthToDate,
              trailingMonths,
              owed: await arBalance(tx, scope),
              overdueCount: overdue?.count ?? 0,
            };
            // Version-tag the cache key so a prompt/advisor change (CASH_FLOW_NUDGE_VERSION)
            // regenerates cached nudges — the signals hash alone wouldn't change.
            const hash = createHash('sha256')
              .update(JSON.stringify({ v: CASH_FLOW_NUDGE_VERSION, signals }))
              .digest('hex');
            return {
              cachedNudges: company.cachedNudges,
              cachedHash: company.cachedHash,
              cachedGeneratedAt: company.generatedAt,
              signals,
              hash,
            };
          });
          if (!prep) return c.json({ error: 'company_not_found' }, 404);
          const { cachedNudges, cachedHash, cachedGeneratedAt, signals, hash } = prep;

          // Cache hit: signals unchanged since the last generation → no model call.
          if (cachedNudges && cachedHash === hash) {
            return c.json({
              nudges: cachedNudges,
              generatedAt: cachedGeneratedAt?.toISOString() ?? null,
            });
          }

          // No usable credential for this account: serve stale cache if we have
          // it, else 503 — same shape as the old advisor-null branch.
          if (!credential) {
            if (cachedNudges) {
              return c.json({
                nudges: cachedNudges,
                generatedAt: cachedGeneratedAt?.toISOString() ?? null,
              });
            }
            return c.json({ error: 'ai_not_configured' }, 503);
          }

          // Cache miss: regenerate (no DB connection held), persist, return. A
          // model failure leaves the old cache intact and surfaces 502 (the
          // streamed UI shows nothing).
          const advisor = deps.advisor ?? defaultAdvisor;
          let nudges: Awaited<ReturnType<CashFlowAdvisor['advise']>>;
          try {
            nudges = await advisor.advise(signals, credential);
          } catch (err) {
            await recordLlmCallHealth(deps.llmConnections, accountId, credential, err);
            return c.json({ error: 'nudges_failed' }, 502);
          }
          // Success → clear any prior error, state-change-only.
          await recordLlmCallHealth(deps.llmConnections, accountId, credential);
          const generatedAt = new Date();
          // tx2: persist the regenerated cache.
          await c.var.runInTx(async (tx) => {
            await tx
              .update(companies)
              .set({
                cashFlowNudges: nudges,
                nudgesInputHash: hash,
                nudgesGeneratedAt: generatedAt,
              })
              .where(and(eq(companies.id, id), eq(companies.accountId, accountId)));
          });

          return c.json({ nudges, generatedAt: generatedAt.toISOString() });
        },
      )
      // Anomaly flagging (AI-layer insight, deterministic): unusual spending vs
      // the customer's own history. Computed straight from the expenses table
      // (edits update the row in place, deletes set deleted_at — so summing
      // `amount` where deleted_at is null is the correct current total, no
      // ledger-reversal handling needed). Rolling windows avoid the partial-
      // calendar-month trap: `recent` = last 30 days; `baseline` = the 90 days
      // before that, averaged to a per-30-day figure ("your typical month").
      // Flags overall spend and per-category spikes; the % + a min-dollar floor
      // suppress noise on tiny categories. No LLM — the numbers are the insight.
      .get('/api/companies/:id/spending-anomalies', async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        const tx = c.get('tx');
        const accountId = c.get('accountId');

        const [company] = await tx
          .select({ id: companies.id })
          .from(companies)
          .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
          .limit(1);
        if (!company) return c.json({ error: 'company_not_found' }, 404);

        // Window boundaries as YYYY-MM-DD (ISO strings sort chronologically, so
        // string comparison on the bare `expense_date` column is correct).
        const now = new Date();
        const dayMs = 86_400_000;
        const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
        const today = ymd(now.getTime());
        const recentStart = ymd(now.getTime() - 29 * dayMs); // last 30 days incl. today
        const baselineEnd = ymd(now.getTime() - 30 * dayMs); // day before the recent window
        const baselineStart = ymd(now.getTime() - 119 * dayMs); // 90 days before that

        const rows = await tx
          .select({
            code: chartOfAccounts.code,
            name: chartOfAccounts.name,
            recent: sql<string>`coalesce(sum(${expenses.amount}) filter (where ${expenses.expenseDate} >= ${recentStart}), 0)`,
            baseline: sql<string>`coalesce(sum(${expenses.amount}) filter (where ${expenses.expenseDate} <= ${baselineEnd}), 0)`,
          })
          .from(expenses)
          .innerJoin(chartOfAccounts, eq(expenses.categoryAccountId, chartOfAccounts.id))
          .where(
            and(
              eq(expenses.accountId, accountId),
              eq(expenses.companyId, id),
              isNull(expenses.deletedAt),
              gte(expenses.expenseDate, baselineStart),
              lte(expenses.expenseDate, today),
            ),
          )
          .groupBy(chartOfAccounts.id, chartOfAccounts.code, chartOfAccounts.name);

        // Thresholds: overall flags at +40% over the typical month; a category
        // needs +50% AND at least $50 of recent spend so a tiny line doesn't
        // shout. baseline is divided by 3 (three 30-day windows) to a per-month
        // average.
        const OVERALL_OVER = 0.4;
        const CATEGORY_OVER = 0.5;
        const CATEGORY_MIN_RECENT = 50;

        let recentTotal = 0;
        let baselineTotal = 0;
        const categories: {
          code: string;
          name: string;
          recent: string;
          typical: string;
          pctOver: number;
        }[] = [];
        for (const r of rows) {
          const recent = Number(r.recent);
          const typical = Number(r.baseline) / 3;
          recentTotal += recent;
          baselineTotal += Number(r.baseline);
          if (
            typical > 0 &&
            recent >= typical * (1 + CATEGORY_OVER) &&
            recent >= CATEGORY_MIN_RECENT
          ) {
            categories.push({
              code: r.code,
              name: r.name,
              recent: recent.toFixed(2),
              typical: typical.toFixed(2),
              pctOver: Math.round((recent / typical - 1) * 100),
            });
          }
        }
        categories.sort((a, b) => b.pctOver - a.pctOver);

        const typicalTotal = baselineTotal / 3;
        const enoughHistory = baselineTotal > 0;
        const overall =
          enoughHistory && recentTotal >= typicalTotal * (1 + OVERALL_OVER)
            ? {
                recent: recentTotal.toFixed(2),
                typical: typicalTotal.toFixed(2),
                pctOver: Math.round((recentTotal / typicalTotal - 1) * 100),
              }
            : null;

        return c.json({ enoughHistory, overall, categories: categories.slice(0, 5) });
      })
  );
}

export type ReportsAppType = ReturnType<typeof reportsRoutes>;

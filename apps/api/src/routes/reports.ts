import { createHash } from 'node:crypto';
import {
  CASH_FLOW_NUDGE_VERSION,
  type CashFlowAdvisor,
  type CashFlowSignals,
} from '@thalermark/ai';
import {
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
import { and, asc, eq, gte, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { validator } from 'hono/validator';
import type { AppDeps } from '../app.js';
import { apBalance, arBalance, cashFlowNet, cashOnHand } from '../lib/ledger.js';
import { UUID_RE } from '../lib/route-helpers.js';
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
          let totalRevenue = 0;
          let totalExpenses = 0;
          for (const r of rows) {
            const amt = Number(r.amount);
            // Drop accounts that net to zero in the window (e.g. a sale fully
            // voided in-period) so the statement isn't cluttered with no-ops.
            if (amt === 0) continue;
            const line: Line = {
              code: r.code,
              name: r.name,
              taxMapping: r.taxMapping,
              amount: r.amount,
            };
            if (r.accountType === 'revenue') {
              revenue.push(line);
              totalRevenue += amt;
            } else {
              expenses.push(line);
              totalExpenses += amt;
            }
          }

          return c.json({
            from,
            to,
            revenue,
            expenses,
            totalRevenue: totalRevenue.toFixed(2),
            totalExpenses: totalExpenses.toFixed(2),
            netProfit: (totalRevenue - totalExpenses).toFixed(2),
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

          const totalSales = rows.reduce((s, r) => s + Number(r.sales), 0).toFixed(2);
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

          const total = rows.reduce((s, r) => s + Number(r.revenue), 0).toFixed(2);
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
          let totalAssets = 0;
          let totalLiabilities = 0;
          let equitySum = 0;
          let revenueSum = 0;
          let expenseSum = 0;
          for (const r of rows) {
            const amt = Number(r.amount);
            if (amt === 0) continue;
            const line: Line = { code: r.code, name: r.name, amount: r.amount };
            if (r.accountType === 'asset') {
              assets.push(line);
              totalAssets += amt;
            } else if (r.accountType === 'liability') {
              liabilities.push(line);
              totalLiabilities += amt;
            } else if (r.accountType === 'equity') {
              equity.push(line);
              equitySum += amt;
            } else if (r.accountType === 'revenue') {
              revenueSum += amt;
            } else {
              expenseSum += amt;
            }
          }
          // Net income (retained earnings while the books stay open) closes the
          // identity: Assets = Liabilities + (explicit equity + net income).
          const netIncome = revenueSum - expenseSum;
          const totalEquity = equitySum + netIncome;
          const totalLiabilitiesAndEquity = totalLiabilities + totalEquity;
          return c.json({
            asOf,
            assets,
            liabilities,
            equity,
            netIncome: netIncome.toFixed(2),
            totalAssets: totalAssets.toFixed(2),
            totalLiabilities: totalLiabilities.toFixed(2),
            totalEquity: totalEquity.toFixed(2),
            totalLiabilitiesAndEquity: totalLiabilitiesAndEquity.toFixed(2),
            // True by construction (every entry balances); surfaced as an
            // integrity check — a false here means the ledger has drifted.
            balanced: Math.abs(totalAssets - totalLiabilitiesAndEquity) < 0.005,
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
          const bucketTotals = new Map(BUCKETS.map((b) => [b.key, { count: 0, amount: 0 }]));
          const outstanding = rows
            .map((r) => {
              const dueMs = new Date(`${r.dueDate}T00:00:00Z`).getTime();
              const daysPastDue = Math.round((asOfMs - dueMs) / 86_400_000);
              const bucket = BUCKETS.find((b) => daysPastDue >= b.min && daysPastDue <= b.max);
              const key = bucket?.key ?? 'current';
              const agg = bucketTotals.get(key);
              if (agg) {
                agg.count += 1;
                agg.amount += Number(r.total);
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

          const total = outstanding.reduce((s, r) => s + Number(r.amount), 0).toFixed(2);
          return c.json({
            asOf,
            buckets: BUCKETS.map((b) => {
              const agg = bucketTotals.get(b.key);
              return {
                key: b.key,
                label: b.label,
                count: agg?.count ?? 0,
                amount: (agg?.amount ?? 0).toFixed(2),
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

          const total = rows.reduce((s, r) => s + Number(r.collected), 0).toFixed(2);
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
      .get('/api/companies/:id/cash-flow-nudges', async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);

        const tx = c.get('tx');
        const accountId = c.get('accountId');

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
        if (!company) return c.json({ error: 'company_not_found' }, 404);

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

        // Cache hit: signals unchanged since the last generation → no model call.
        if (company.cachedNudges && company.cachedHash === hash) {
          return c.json({
            nudges: company.cachedNudges,
            generatedAt: company.generatedAt?.toISOString() ?? null,
          });
        }

        // No advisor configured: serve stale cache if we have it, else 503.
        if (!deps.advisor) {
          if (company.cachedNudges) {
            return c.json({
              nudges: company.cachedNudges,
              generatedAt: company.generatedAt?.toISOString() ?? null,
            });
          }
          return c.json({ error: 'ai_not_configured' }, 503);
        }

        // Cache miss: regenerate, persist, return. A model failure leaves the
        // old cache intact and surfaces 502 (the streamed UI shows nothing).
        let nudges: Awaited<ReturnType<CashFlowAdvisor['advise']>>;
        try {
          nudges = await deps.advisor.advise(signals);
        } catch (_err) {
          return c.json({ error: 'nudges_failed' }, 502);
        }
        const generatedAt = new Date();
        await tx
          .update(companies)
          .set({ cashFlowNudges: nudges, nudgesInputHash: hash, nudgesGeneratedAt: generatedAt })
          .where(and(eq(companies.id, id), eq(companies.accountId, accountId)));

        return c.json({ nudges, generatedAt: generatedAt.toISOString() });
      })
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

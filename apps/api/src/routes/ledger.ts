import {
  capitalPurchases,
  chartOfAccounts,
  companies,
  journalEntries,
  journalLines,
  periodCloses,
} from '@thalermark/db';
import {
  type DepreciationConvention,
  manualJournalEntryCreateSchema,
  periodCloseCreateSchema,
  periodCloseEquityLabel,
} from '@thalermark/validation';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { depreciateOnce } from '../lib/depreciation.js';
import {
  MANUAL_ADJUSTMENT_REVERSAL_SOURCE,
  MANUAL_ADJUSTMENT_SOURCE,
  type ManualJournalLine,
  postManualJournalEntry,
  reverseManualJournalEntry,
} from '../lib/ledger.js';
import { applyCursor, keysetOrderBy, parseLimit, slicePage } from '../lib/pagination.js';
import {
  buildClosingPlan,
  closingBalances,
  fiscalYearEndInstant,
  postYearEndClose,
  resolveEquityTarget,
  reverseYearEndClose,
} from '../lib/period-close.js';
import { UUID_RE, expenseDateToPostedAt } from '../lib/route-helpers.js';
import { requireCapability } from '../middleware/authz.js';
import type { RlsVariables } from '../middleware/rls-context.js';

// ledger — "The Ledger": the gated manual-journal-adjustment portal (Prong B).
// The ONE place in the product where accounting vocabulary is shown on purpose:
// the owner / admin / accountant (gated by the `ledger:adjust` capability) posts
// balanced debit/credit entries exactly as their CPA dictated — year-end
// adjustments, reclassifications, depreciation. Everywhere else the double-entry
// stays hidden ([[project_ledger_decision]]); here it is the surface.
//
// A manual entry IS a journal_entries row — there is no separate domain table
// (the journal entry is the concept). Provenance rides on the polymorphic
// source_entity_* columns: an original is `source_entity_type='manual_adjustment'`
// self-referencing its own id; a reversal is `'manual_adjustment_reversal'`
// pointing at the original (so the two share a source group and cashFlowNet's
// per-source netting cancels them). Append-only like the rest of the ledger: a
// mistake is fixed with a reversing entry (POST .../reverse), never an edit.
//
// Deps-free pure-tenant sub-app (cf. owner-money / bills); mounted on createApp
// via .route() so its schema rides on its own LedgerAppType instead of bloating
// AppType past the TS7056 ceiling. entityType 'manual_adjustment' is registered
// in the activity feed (routes/audit-events.ts).

// One enriched posting line in an API response: the user-picked account plus its
// code/name (joined from the COA) so the client can render "6350 Depreciation
// Expense" without a second lookup.
type EntryLine = {
  coaAccountId: string;
  code: string;
  accountName: string;
  accountType: string;
  side: 'debit' | 'credit';
  amount: string;
};

export function ledgerRoutes() {
  return (
    new Hono<{ Variables: RlsVariables }>()
      .post(
        '/api/ledger/entries',
        requireCapability('ledger:adjust'),
        validator('json', (value, c) => {
          const parsed = manualJournalEntryCreateSchema.safeParse(value);
          if (!parsed.success) {
            return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
          }
          return parsed.data;
        }),
        async (c) => {
          const tx = c.get('tx');
          const accountId = c.get('accountId');
          const { companyId, postedOn, memo, lines } = c.req.valid('json');

          const [company] = await tx
            .select({ id: companies.id })
            .from(companies)
            .where(and(eq(companies.id, companyId), eq(companies.accountId, accountId)))
            .limit(1);
          if (!company) return c.json({ error: 'company_not_found' }, 404);

          // Resolve + validate every chosen account in one query: it must belong
          // to this company (account-scoped for defense in depth,
          // [[architecture_account_id_explicit_filter]]) and be active. Any line
          // referencing an unknown / other-company / archived account fails the
          // whole entry with a clean 400 — manual entries can hit ANY account
          // type, so there is no account_type restriction. The code/name come
          // back too, to enrich the response without a second lookup.
          const wantedIds = Array.from(new Set(lines.map((l) => l.coaAccountId)));
          const coaRows = await tx
            .select({
              id: chartOfAccounts.id,
              code: chartOfAccounts.code,
              name: chartOfAccounts.name,
              accountType: chartOfAccounts.accountType,
            })
            .from(chartOfAccounts)
            .where(
              and(
                eq(chartOfAccounts.accountId, accountId),
                eq(chartOfAccounts.companyId, companyId),
                eq(chartOfAccounts.isActive, true),
                inArray(chartOfAccounts.id, wantedIds),
              ),
            );
          const byId = new Map(coaRows.map((r) => [r.id, r]));
          if (byId.size !== wantedIds.length) {
            return c.json({ error: 'invalid_account' }, 400);
          }

          const postedAt = expenseDateToPostedAt(postedOn);
          const postLines: ManualJournalLine[] = lines.map((l) => ({
            coaAccountId: l.coaAccountId,
            side: l.side,
            amount: l.amount,
          }));
          const entryId = await postManualJournalEntry(tx, {
            accountId,
            companyId,
            postedAt,
            memo,
            lines: postLines,
          });

          const entryLines: EntryLine[] = lines.map((l) => {
            const acc = byId.get(l.coaAccountId);
            return {
              coaAccountId: l.coaAccountId,
              code: acc?.code ?? '',
              accountName: acc?.name ?? '',
              accountType: acc?.accountType ?? '',
              side: l.side,
              amount: l.amount,
            };
          });
          const created = {
            id: entryId,
            companyId,
            postedAt: postedAt.toISOString(),
            memo,
            lines: entryLines,
            reversed: false,
            reversalId: null as string | null,
          };

          await c.var.audit({
            entityType: 'manual_adjustment',
            entityId: entryId,
            action: 'create',
            after: created,
            companyId,
          });

          return c.json(created, 201);
        },
      )
      .get('/api/ledger/entries', async (c) => {
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const companyId = c.req.query('companyId');

        const limit = parseLimit(c.req.query('limit'));
        if (limit === null) return c.json({ error: 'invalid_limit' }, 400);
        // posted_at is the effective ledger date (timestamp); id breaks ties.
        const keys = [
          { col: journalEntries.postedAt, revive: (v: unknown) => new Date(v as string) },
          { col: journalEntries.id },
        ];
        const keyset = applyCursor(c.req.query('cursor'), keys, 'desc');
        if (keyset === 'invalid') return c.json({ error: 'invalid_cursor' }, 400);

        const conditions = [
          eq(journalEntries.accountId, accountId),
          eq(journalEntries.sourceEntityType, MANUAL_ADJUSTMENT_SOURCE),
        ];
        if (companyId) conditions.push(eq(journalEntries.companyId, companyId));

        const rows = await tx
          .select({
            id: journalEntries.id,
            postedAt: journalEntries.postedAt,
            memo: journalEntries.memo,
          })
          .from(journalEntries)
          .where(and(...conditions, ...(keyset ? [keyset] : [])))
          .orderBy(keysetOrderBy(keys, 'desc'))
          .limit(limit + 1);
        const page = slicePage(rows, limit, (r) => [r.postedAt, r.id]);

        // Two follow-up lookups for the page (not N+1): the debit total per
        // entry (= the entry's magnitude, since debits == credits) and which
        // entries have been reversed.
        const pageIds = page.rows.map((r) => r.id);
        const debitByEntry = new Map<string, string>();
        const reversedSet = new Set<string>();
        if (pageIds.length > 0) {
          const totals = await tx
            .select({
              entryId: journalLines.journalEntryId,
              total: sql<string>`coalesce(sum(${journalLines.amount}) filter (where ${journalLines.side} = 'debit'), 0)::numeric(15,2)`,
            })
            .from(journalLines)
            .where(
              and(
                eq(journalLines.accountId, accountId),
                inArray(journalLines.journalEntryId, pageIds),
              ),
            )
            .groupBy(journalLines.journalEntryId);
          for (const t of totals) debitByEntry.set(t.entryId, t.total);

          const reversals = await tx
            .select({ original: journalEntries.sourceEntityId })
            .from(journalEntries)
            .where(
              and(
                eq(journalEntries.accountId, accountId),
                eq(journalEntries.sourceEntityType, MANUAL_ADJUSTMENT_REVERSAL_SOURCE),
                inArray(journalEntries.sourceEntityId, pageIds),
              ),
            );
          for (const r of reversals) reversedSet.add(r.original);
        }

        return c.json({
          entries: page.rows.map((r) => ({
            id: r.id,
            postedAt: r.postedAt.toISOString(),
            memo: r.memo,
            amount: debitByEntry.get(r.id) ?? '0.00',
            reversed: reversedSet.has(r.id),
          })),
          nextCursor: page.nextCursor,
        });
      })
      .get('/api/ledger/entries/:id', async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        const tx = c.get('tx');
        const accountId = c.get('accountId');

        const [entry] = await tx
          .select({
            id: journalEntries.id,
            companyId: journalEntries.companyId,
            postedAt: journalEntries.postedAt,
            memo: journalEntries.memo,
          })
          .from(journalEntries)
          .where(
            and(
              eq(journalEntries.id, id),
              eq(journalEntries.accountId, accountId),
              eq(journalEntries.sourceEntityType, MANUAL_ADJUSTMENT_SOURCE),
            ),
          )
          .limit(1);
        if (!entry) return c.json({ error: 'manual_adjustment_not_found' }, 404);

        const lineRows = await tx
          .select({
            coaAccountId: journalLines.coaAccountId,
            code: chartOfAccounts.code,
            accountName: chartOfAccounts.name,
            accountType: chartOfAccounts.accountType,
            side: journalLines.side,
            amount: journalLines.amount,
          })
          .from(journalLines)
          .innerJoin(chartOfAccounts, eq(journalLines.coaAccountId, chartOfAccounts.id))
          .where(and(eq(journalLines.accountId, accountId), eq(journalLines.journalEntryId, id)))
          .orderBy(chartOfAccounts.code);

        // Is there a reversal pointing at this entry? If so surface its id so
        // the UI can link to it and disable the (now spent) Reverse action.
        const [reversal] = await tx
          .select({ id: journalEntries.id })
          .from(journalEntries)
          .where(
            and(
              eq(journalEntries.accountId, accountId),
              eq(journalEntries.sourceEntityType, MANUAL_ADJUSTMENT_REVERSAL_SOURCE),
              eq(journalEntries.sourceEntityId, id),
            ),
          )
          .limit(1);

        return c.json({
          id: entry.id,
          companyId: entry.companyId,
          postedAt: entry.postedAt.toISOString(),
          memo: entry.memo,
          lines: lineRows.map((l) => ({
            coaAccountId: l.coaAccountId,
            code: l.code,
            accountName: l.accountName,
            accountType: l.accountType,
            side: l.side as 'debit' | 'credit',
            amount: l.amount,
          })),
          reversed: !!reversal,
          reversalId: reversal?.id ?? null,
        });
      })
      .post('/api/ledger/entries/:id/reverse', requireCapability('ledger:adjust'), async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        const tx = c.get('tx');
        const accountId = c.get('accountId');

        const [entry] = await tx
          .select({
            id: journalEntries.id,
            companyId: journalEntries.companyId,
            postedAt: journalEntries.postedAt,
            memo: journalEntries.memo,
          })
          .from(journalEntries)
          .where(
            and(
              eq(journalEntries.id, id),
              eq(journalEntries.accountId, accountId),
              eq(journalEntries.sourceEntityType, MANUAL_ADJUSTMENT_SOURCE),
            ),
          )
          .limit(1);
        if (!entry) return c.json({ error: 'manual_adjustment_not_found' }, 404);

        // Already reversed? An entry gets exactly one reversal — reversing a
        // reversal would just re-post the original, which is a fresh entry, not
        // an "un-reverse". 409 so the client can disable the action.
        const [existing] = await tx
          .select({ id: journalEntries.id })
          .from(journalEntries)
          .where(
            and(
              eq(journalEntries.accountId, accountId),
              eq(journalEntries.sourceEntityType, MANUAL_ADJUSTMENT_REVERSAL_SOURCE),
              eq(journalEntries.sourceEntityId, id),
            ),
          )
          .limit(1);
        if (existing) return c.json({ error: 'already_reversed' }, 409);

        const originalLines = await tx
          .select({
            coaAccountId: journalLines.coaAccountId,
            side: journalLines.side,
            amount: journalLines.amount,
          })
          .from(journalLines)
          .where(and(eq(journalLines.accountId, accountId), eq(journalLines.journalEntryId, id)));

        const reversalId = await reverseManualJournalEntry(tx, {
          accountId,
          companyId: entry.companyId,
          originalEntryId: id,
          originalLines: originalLines.map((l) => ({
            coaAccountId: l.coaAccountId,
            side: l.side as 'debit' | 'credit',
            amount: l.amount,
          })),
          // Reverse at the original's effective date so the period nets cleanly.
          postedAt: entry.postedAt,
          memo: `Reversal of: ${entry.memo ?? 'manual entry'}`,
        });

        await c.var.audit({
          entityType: 'manual_adjustment',
          entityId: id,
          action: 'reverse',
          after: { reversalId },
          companyId: entry.companyId,
        });

        return c.json({ id, reversed: true, reversalId });
      })
      // ── Year-end close (TMC-159) ───────────────────────────────────────────
      // Rolls a fiscal year's revenue + expense accounts (and withdrawals) into
      // equity so the next year starts at zero, and locks the year so nothing can
      // silently change it. Lives here rather than on its own sub-app because it
      // shares the portal, the capability and the closing-entry idiom.
      //
      // Routes are ordered before nothing else — but note /preview must be
      // declared before any /:id route on this prefix (Hono is first-match).
      .get('/api/ledger/period-closes', async (c) => {
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const companyId = c.req.query('companyId');
        if (!companyId || !UUID_RE.test(companyId))
          return c.json({ error: 'invalid_company' }, 400);

        const rows = await tx
          .select({
            id: periodCloses.id,
            fiscalYear: periodCloses.fiscalYear,
            closedThrough: periodCloses.closedThrough,
            journalEntryId: periodCloses.journalEntryId,
            netIncome: periodCloses.netIncome,
            equityCode: periodCloses.equityCode,
            createdAt: periodCloses.createdAt,
          })
          .from(periodCloses)
          .where(
            and(
              eq(periodCloses.accountId, accountId),
              eq(periodCloses.companyId, companyId),
              isNull(periodCloses.deletedAt),
            ),
          )
          .orderBy(desc(periodCloses.fiscalYear));

        return c.json({
          closes: rows.map((r) => ({
            id: r.id,
            fiscalYear: r.fiscalYear,
            closedThrough: r.closedThrough.toISOString(),
            journalEntryId: r.journalEntryId,
            netIncome: r.netIncome,
            equityCode: r.equityCode,
            closedAt: r.createdAt.toISOString(),
          })),
        });
      })
      // What a close WOULD roll, without committing. Drives the confirm screen so
      // the user sees the figure before locking anything.
      .get('/api/ledger/period-closes/preview', async (c) => {
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const companyId = c.req.query('companyId');
        const fiscalYear = Number(c.req.query('fiscalYear'));
        if (!companyId || !UUID_RE.test(companyId))
          return c.json({ error: 'invalid_company' }, 400);

        const parsed = periodCloseCreateSchema.safeParse({ companyId, fiscalYear });
        if (!parsed.success) return c.json({ error: 'invalid_fiscal_year' }, 400);

        const company = await companyForClose(tx, accountId, companyId);
        if (!company) return c.json({ error: 'company_not_found' }, 404);

        const guard = await guardClosable(tx, {
          accountId,
          companyId,
          fiscalYear,
          timezone: company.timezone,
        });
        if ('error' in guard) return c.json({ error: guard.error }, guard.status);

        const equity = await resolveEquityTarget(tx, {
          accountId,
          companyId,
          businessType: company.businessType,
        });
        if (!equity) return c.json({ error: 'equity_account_missing' }, 409);

        const balances = await closingBalances(tx, {
          accountId,
          companyId,
          closedThrough: guard.closedThrough,
        });
        const plan = buildClosingPlan(balances, equity);

        return c.json({
          fiscalYear,
          closedThrough: guard.closedThrough.toISOString(),
          equityCode: equity.code,
          equityLabel: periodCloseEquityLabel(company.businessType),
          netIncome: plan?.netIncome ?? '0.00',
          withdrawals: plan?.withdrawals ?? '0.00',
          // Nothing on the books for the span — the UI says so instead of
          // offering a close that would post an empty entry.
          empty: plan === null,
        });
      })
      .post(
        '/api/ledger/period-closes',
        requireCapability('ledger:adjust'),
        validator('json', (value, c) => {
          const parsed = periodCloseCreateSchema.safeParse(value);
          if (!parsed.success) {
            return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
          }
          return parsed.data;
        }),
        async (c) => {
          const tx = c.get('tx');
          const accountId = c.get('accountId');
          const { companyId, fiscalYear } = c.req.valid('json');

          const company = await companyForClose(tx, accountId, companyId);
          if (!company) return c.json({ error: 'company_not_found' }, 404);

          const guard = await guardClosable(tx, {
            accountId,
            companyId,
            fiscalYear,
            timezone: company.timezone,
          });
          if ('error' in guard) return c.json({ error: guard.error }, guard.status);

          // Book depreciation before rolling. The daily sweep posts year Y at 31 Dec
          // of Y; closing Y before it has caught up would lose the deduction AND
          // leave the sweep failing on that purchase every run afterwards, since the
          // year would then be locked. Doing it here also matches what an accountant
          // does — depreciation, then close.
          const purchases = await tx
            .select({ purchase: capitalPurchases })
            .from(capitalPurchases)
            .where(
              and(
                eq(capitalPurchases.accountId, accountId),
                eq(capitalPurchases.companyId, companyId),
                eq(capitalPurchases.taxTreatment, 'spread'),
                isNull(capitalPurchases.deletedAt),
              ),
            );
          for (const row of purchases) {
            await depreciateOnce(tx, {
              purchase: row.purchase,
              convention: company.depreciationConvention as DepreciationConvention,
              timezone: company.timezone,
            });
          }

          const equity = await resolveEquityTarget(tx, {
            accountId,
            companyId,
            businessType: company.businessType,
          });
          if (!equity) return c.json({ error: 'equity_account_missing' }, 409);

          const balances = await closingBalances(tx, {
            accountId,
            companyId,
            closedThrough: guard.closedThrough,
          });
          const plan = buildClosingPlan(balances, equity);
          if (!plan) return c.json({ error: 'nothing_to_close' }, 409);

          const { periodCloseId, journalEntryId } = await postYearEndClose(tx, {
            accountId,
            companyId,
            fiscalYear,
            closedThrough: guard.closedThrough,
            plan,
          });

          const created = {
            id: periodCloseId,
            companyId,
            fiscalYear,
            closedThrough: guard.closedThrough.toISOString(),
            journalEntryId,
            netIncome: plan.netIncome,
            withdrawals: plan.withdrawals,
            equityCode: plan.equityCode,
          };

          await c.var.audit({
            entityType: 'period_close',
            entityId: periodCloseId,
            action: 'create',
            after: created,
            companyId,
          });

          return c.json(created, 201);
        },
      )
      // Re-open a closed year. Posts the reversal of the closing entry and soft-
      // deletes the row; the ledger stays append-only.
      .post(
        '/api/ledger/period-closes/:id/reopen',
        requireCapability('ledger:adjust'),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
          const tx = c.get('tx');
          const accountId = c.get('accountId');

          const [row] = await tx
            .select({
              id: periodCloses.id,
              companyId: periodCloses.companyId,
              fiscalYear: periodCloses.fiscalYear,
              closedThrough: periodCloses.closedThrough,
              journalEntryId: periodCloses.journalEntryId,
            })
            .from(periodCloses)
            .where(
              and(
                eq(periodCloses.id, id),
                eq(periodCloses.accountId, accountId),
                isNull(periodCloses.deletedAt),
              ),
            )
            .limit(1);
          if (!row) return c.json({ error: 'period_close_not_found' }, 404);

          // A later year still being closed would leave the re-opened year locked
          // anyway (the lock reads the newest active close), so refuse rather than
          // pretend. Re-open the newest year first.
          const [newer] = await tx
            .select({ fiscalYear: periodCloses.fiscalYear })
            .from(periodCloses)
            .where(
              and(
                eq(periodCloses.accountId, accountId),
                eq(periodCloses.companyId, row.companyId),
                isNull(periodCloses.deletedAt),
                sql`${periodCloses.fiscalYear} > ${row.fiscalYear}`,
              ),
            )
            .limit(1);
          if (newer) return c.json({ error: 'later_year_still_closed' }, 409);

          const reversalId = await reverseYearEndClose(tx, {
            accountId,
            companyId: row.companyId,
            periodCloseId: row.id,
            journalEntryId: row.journalEntryId,
            fiscalYear: row.fiscalYear,
            closedThrough: row.closedThrough,
          });

          await c.var.audit({
            entityType: 'period_close',
            entityId: row.id,
            action: 'reopen',
            after: { reversalId, fiscalYear: row.fiscalYear },
            companyId: row.companyId,
          });

          return c.json({ id: row.id, fiscalYear: row.fiscalYear, reopened: true, reversalId });
        },
      )
  );
}

// The three per-company inputs a close needs: the entity type (which equity
// account absorbs the profit), the zone (where the year boundary falls) and the
// convention (for the depreciation catch-up).
async function companyForClose(
  tx: RlsVariables['tx'],
  accountId: string,
  companyId: string,
): Promise<{
  businessType: string | null;
  timezone: string;
  depreciationConvention: string;
} | null> {
  const [row] = await tx
    .select({
      businessType: companies.businessType,
      timezone: companies.timezone,
      depreciationConvention: companies.depreciationConvention,
    })
    .from(companies)
    .where(and(eq(companies.id, companyId), eq(companies.accountId, accountId)))
    .limit(1);
  return row ?? null;
}

// Shared preconditions for previewing or performing a close. Returns the
// resolved period boundary, or an error + status the caller returns verbatim.
async function guardClosable(
  tx: RlsVariables['tx'],
  args: { accountId: string; companyId: string; fiscalYear: number; timezone: string },
): Promise<{ closedThrough: Date } | { error: string; status: 409 }> {
  const closedThrough = await fiscalYearEndInstant(tx, {
    fiscalYear: args.fiscalYear,
    timezone: args.timezone,
  });

  // You cannot close a year you are still living through — the figures aren't
  // final. Compared against the boundary instant rather than a local year
  // string so it rolls over at the operator's midnight, not UTC's.
  if (closedThrough > new Date()) return { error: 'year_not_finished', status: 409 };

  const [existing] = await tx
    .select({ id: periodCloses.id, fiscalYear: periodCloses.fiscalYear })
    .from(periodCloses)
    .where(
      and(
        eq(periodCloses.accountId, args.accountId),
        eq(periodCloses.companyId, args.companyId),
        isNull(periodCloses.deletedAt),
        sql`${periodCloses.fiscalYear} >= ${args.fiscalYear}`,
      ),
    )
    // Ascending so the requested year itself wins over a later one when both are
    // closed — otherwise which message you get would depend on row order.
    .orderBy(asc(periodCloses.fiscalYear))
    .limit(1);
  if (existing) {
    // Either this exact year is already closed, or a later one is — which locks
    // this one too, so closing it now would post into a locked period.
    return {
      error: existing.fiscalYear === args.fiscalYear ? 'already_closed' : 'later_year_closed',
      status: 409,
    };
  }

  return { closedThrough };
}

export type LedgerAppType = ReturnType<typeof ledgerRoutes>;

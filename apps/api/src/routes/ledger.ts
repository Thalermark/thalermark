import { chartOfAccounts, companies, journalEntries, journalLines } from '@thalermark/db';
import { manualJournalEntryCreateSchema } from '@thalermark/validation';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  MANUAL_ADJUSTMENT_REVERSAL_SOURCE,
  MANUAL_ADJUSTMENT_SOURCE,
  type ManualJournalLine,
  postManualJournalEntry,
  reverseManualJournalEntry,
} from '../lib/ledger.js';
import { applyCursor, keysetOrderBy, parseLimit, slicePage } from '../lib/pagination.js';
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
  return new Hono<{ Variables: RlsVariables }>()
    .post('/api/ledger/entries', requireCapability('ledger:adjust'), async (c) => {
      const body = await c.req.json().catch(() => null);
      const parsed = manualJournalEntryCreateSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
      }

      const tx = c.get('tx');
      const accountId = c.get('accountId');
      const { companyId, postedOn, memo, lines } = parsed.data;

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
    })
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
    });
}

export type LedgerAppType = ReturnType<typeof ledgerRoutes>;

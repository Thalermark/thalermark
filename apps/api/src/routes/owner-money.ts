import {
  chartOfAccounts,
  companies,
  openingBalanceLines,
  openingBalances,
  ownerMoneyEvents,
} from '@thalermark/db';
import {
  type OwnerMoneyEventKind,
  openingBalanceFullUpsertSchema,
  openingBalanceUpsertSchema,
  ownerMoneyEventCreateSchema,
  ownerMoneyEventUpdateSchema,
} from '@thalermark/validation';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { v7 as uuidv7 } from 'uuid';
import {
  postOpeningBalance,
  postOpeningBalanceReversal,
  postOwnerMoneyEvent,
  postOwnerMoneyEventReversal,
  simpleOpeningBalanceLines,
} from '../lib/ledger.js';
import { applyCursor, keysetOrderBy, parseLimit, slicePage } from '../lib/pagination.js';
import { UUID_RE, expenseDateToPostedAt } from '../lib/route-helpers.js';
import { requireCapability } from '../middleware/authz.js';
import type { RlsVariables } from '../middleware/rls-context.js';

// owner-money — owner money events: the owner putting their own money into the
// business or paying themselves. This is the only path that posts to Owner's
// Equity (3000) / Owner's Draw (3100), which were seeded into every company's
// chart but, before this entity, never touched (an independent audit finding).
//
// Same hidden-ledger discipline as every other entity — row write + audit +
// posting in one tenant tx so the deferred sum-to-zero trigger fires at commit
// and a posting failure rolls the mutation back. `kind` fully determines the
// posting (contribution → Dr Cash / Cr Owner's Equity; draw → Dr Owner's Draw /
// Cr Cash), so there is no category or payment-account choice — cash is always
// Cash (1000). Edit = reverse the prior entry + repost (like expenses); delete
// is soft (deleted_at) + a reversal. Gated by expenses:write (the same
// money-movement cluster as expenses/bills). entityType 'owner_money_event' is
// registered in the activity feed (routes/audit-events.ts).
//
// Deps-free pure-tenant sub-app (cf. bills/items); mounted on createApp via
// .route() so its schema rides on its own OwnerMoneyEventsAppType instead of
// bloating AppType past the TS7056 ceiling.
export function ownerMoneyRoutes() {
  return (
    new Hono<{ Variables: RlsVariables }>()
      .post('/api/owner-money', requireCapability('expenses:write'), async (c) => {
        const body = await c.req.json().catch(() => null);
        const parsed = ownerMoneyEventCreateSchema.safeParse(body);
        if (!parsed.success) {
          return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
        }

        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const { companyId, kind, amount, occurredOn, memo } = parsed.data;

        const [company] = await tx
          .select({ id: companies.id })
          .from(companies)
          .where(and(eq(companies.id, companyId), eq(companies.accountId, accountId)))
          .limit(1);
        if (!company) return c.json({ error: 'company_not_found' }, 404);

        const eventId = uuidv7();
        const [created] = await tx
          .insert(ownerMoneyEvents)
          .values({
            id: eventId,
            accountId,
            companyId,
            kind,
            amount,
            occurredOn,
            memo: memo ?? null,
          })
          .returning();

        await c.var.audit({
          entityType: 'owner_money_event',
          entityId: eventId,
          action: 'create',
          after: created,
          companyId,
        });

        await postOwnerMoneyEvent(tx, {
          event: { id: eventId, kind, amount },
          accountId,
          companyId,
          postedAt: expenseDateToPostedAt(occurredOn),
        });

        return c.json(created, 201);
      })
      .get('/api/owner-money', async (c) => {
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const companyId = c.req.query('companyId');
        const kind = c.req.query('kind');

        const limit = parseLimit(c.req.query('limit'));
        if (limit === null) return c.json({ error: 'invalid_limit' }, 400);
        // occurred_on is a date column (string), created_at a timestamp (Date).
        const keys = [
          { col: ownerMoneyEvents.occurredOn },
          { col: ownerMoneyEvents.createdAt, revive: (v: unknown) => new Date(v as string) },
          { col: ownerMoneyEvents.id },
        ];
        const keyset = applyCursor(c.req.query('cursor'), keys, 'desc');
        if (keyset === 'invalid') return c.json({ error: 'invalid_cursor' }, 400);

        const conditions = [
          eq(ownerMoneyEvents.accountId, accountId),
          isNull(ownerMoneyEvents.deletedAt),
        ];
        if (companyId) conditions.push(eq(ownerMoneyEvents.companyId, companyId));
        if (kind) conditions.push(eq(ownerMoneyEvents.kind, kind));

        const rows = await tx
          .select()
          .from(ownerMoneyEvents)
          .where(and(...conditions, ...(keyset ? [keyset] : [])))
          .orderBy(keysetOrderBy(keys, 'desc'))
          .limit(limit + 1);
        const page = slicePage(rows, limit, (r) => [r.occurredOn, r.createdAt, r.id]);
        return c.json({ events: page.rows, nextCursor: page.nextCursor });
      })
      // --- Opening balances (one active per company) — "Starting balances" in My
      // Money: what the business already had at the start. Registered BEFORE the
      // /:id routes so the literal '/opening-balance' wins (Hono is first-match;
      // it isn't a UUID so it'd 400 the :id guard anyway). One combined balanced
      // posting against the standard accounts (lib/ledger openingBalanceLines);
      // upsert = reverse + repost, clear = soft-delete + reverse. expenses:write
      // like the rest of My Money. ------------------------------------------------
      .get('/api/owner-money/opening-balance', async (c) => {
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const companyId = c.req.query('companyId');
        if (!companyId || !UUID_RE.test(companyId)) {
          return c.json({ error: 'invalid_company_id' }, 400);
        }
        const [row] = await tx
          .select()
          .from(openingBalances)
          .where(
            and(
              eq(openingBalances.accountId, accountId),
              eq(openingBalances.companyId, companyId),
              isNull(openingBalances.deletedAt),
            ),
          )
          .limit(1);
        if (!row) return c.json({ openingBalance: null, lines: [] });
        // Lines come back joined to the chart so a client can render "1500
        // Vehicles & Equipment" without a second lookup, the same enrichment the
        // ledger portal's entry detail does.
        const lines = await tx
          .select({
            coaAccountId: openingBalanceLines.coaAccountId,
            code: chartOfAccounts.code,
            accountName: chartOfAccounts.name,
            accountType: chartOfAccounts.accountType,
            side: openingBalanceLines.side,
            amount: openingBalanceLines.amount,
          })
          .from(openingBalanceLines)
          .innerJoin(chartOfAccounts, eq(openingBalanceLines.coaAccountId, chartOfAccounts.id))
          .where(
            and(
              eq(openingBalanceLines.accountId, accountId),
              eq(openingBalanceLines.openingBalanceId, row.id),
            ),
          )
          .orderBy(chartOfAccounts.code);
        return c.json({ openingBalance: row, lines });
      })
      .put('/api/owner-money/opening-balance', requireCapability('expenses:write'), async (c) => {
        const body = await c.req.json().catch(() => null);
        const tx = c.get('tx');
        const accountId = c.get('accountId');

        // Two shapes, one route. `lines` present means the full opening trial
        // balance; otherwise it's the three plain questions. Discriminated on the
        // payload rather than split into two endpoints because the result is the
        // same singular row either way — a company has one starting position, and
        // switching how you describe it shouldn't mean a different URL.
        const isFull = body !== null && typeof body === 'object' && 'lines' in body;
        const parsed = isFull
          ? openingBalanceFullUpsertSchema.safeParse(body)
          : openingBalanceUpsertSchema.safeParse(body);
        if (!parsed.success) {
          return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
        }
        const { companyId, asOfDate } = parsed.data;

        const [company] = await tx
          .select({ id: companies.id })
          .from(companies)
          .where(and(eq(companies.id, companyId), eq(companies.accountId, accountId)))
          .limit(1);
        if (!company) return c.json({ error: 'company_not_found' }, 404);

        // Resolve whichever shape arrived down to account-id-keyed lines, which
        // are what gets stored and posted.
        let lines: { coaAccountId: string; side: 'debit' | 'credit'; amount: string }[];
        if ('lines' in parsed.data) {
          // Every account must belong to this company and be active — the same
          // check the ledger portal makes, and for the same reason: an id from
          // another company would post silently into the wrong books.
          const wanted = Array.from(new Set(parsed.data.lines.map((l) => l.coaAccountId)));
          const rows = await tx
            .select({ id: chartOfAccounts.id })
            .from(chartOfAccounts)
            .where(
              and(
                eq(chartOfAccounts.accountId, accountId),
                eq(chartOfAccounts.companyId, companyId),
                eq(chartOfAccounts.isActive, true),
                inArray(chartOfAccounts.id, wanted),
              ),
            );
          if (rows.length !== wanted.length) return c.json({ error: 'invalid_account' }, 400);
          lines = parsed.data.lines;
        } else {
          const { cash, receivables, payables } = parsed.data;
          const coded = simpleOpeningBalanceLines({ cash, receivables, payables });
          const codes = coded.map((l) => l.code);
          const rows = await tx
            .select({ id: chartOfAccounts.id, code: chartOfAccounts.code })
            .from(chartOfAccounts)
            .where(
              and(
                eq(chartOfAccounts.accountId, accountId),
                eq(chartOfAccounts.companyId, companyId),
                inArray(chartOfAccounts.code, codes),
              ),
            );
          const byCode = new Map(rows.map((r) => [r.code, r.id]));
          const missing = codes.filter((code) => !byCode.has(code));
          if (missing.length > 0) return c.json({ error: 'invalid_account' }, 400);
          lines = coded.map((l) => ({
            coaAccountId: byCode.get(l.code) as string,
            side: l.side,
            amount: l.amount,
          }));
        }

        const shape = isFull ? 'full' : 'simple';
        const figures = isFull
          ? { cash: '0', receivables: '0', payables: '0' }
          : {
              cash: (parsed.data as { cash: string }).cash,
              receivables: (parsed.data as { receivables: string }).receivables,
              payables: (parsed.data as { payables: string }).payables,
            };

        const [current] = await tx
          .select()
          .from(openingBalances)
          .where(
            and(
              eq(openingBalances.accountId, accountId),
              eq(openingBalances.companyId, companyId),
              isNull(openingBalances.deletedAt),
            ),
          )
          .limit(1);

        if (current) {
          // Edit = reverse the prior posting + repost, keeping the GL append-only.
          // The reversal is built from the lines AS STORED, not from what's about
          // to replace them — otherwise an edit that changes which accounts are
          // involved would leave the old ones stranded on the books.
          const priorLines = await tx
            .select({
              coaAccountId: openingBalanceLines.coaAccountId,
              side: openingBalanceLines.side,
              amount: openingBalanceLines.amount,
            })
            .from(openingBalanceLines)
            .where(
              and(
                eq(openingBalanceLines.accountId, accountId),
                eq(openingBalanceLines.openingBalanceId, current.id),
              ),
            );
          await postOpeningBalanceReversal(tx, {
            openingBalanceId: current.id,
            lines: priorLines.map((l) => ({
              coaAccountId: l.coaAccountId,
              side: l.side as 'debit' | 'credit',
              amount: l.amount,
            })),
            accountId,
            companyId,
            postedAt: expenseDateToPostedAt(current.asOfDate),
          });

          const [updated] = await tx
            .update(openingBalances)
            .set({ asOfDate, shape, ...figures, updatedAt: new Date() })
            .where(
              and(eq(openingBalances.id, current.id), eq(openingBalances.accountId, accountId)),
            )
            .returning();
          // Lines are replaced wholesale — the parent edit is already a
          // reverse-and-repost, so per-line identity would buy nothing.
          await tx
            .delete(openingBalanceLines)
            .where(
              and(
                eq(openingBalanceLines.accountId, accountId),
                eq(openingBalanceLines.openingBalanceId, current.id),
              ),
            );
          await tx.insert(openingBalanceLines).values(
            lines.map((l) => ({
              id: uuidv7(),
              accountId,
              openingBalanceId: current.id,
              coaAccountId: l.coaAccountId,
              side: l.side,
              amount: l.amount,
            })),
          );
          await c.var.audit({
            entityType: 'opening_balance',
            entityId: current.id,
            action: 'update',
            before: current,
            after: { ...updated, lines },
            companyId,
          });
          await postOpeningBalance(tx, {
            openingBalanceId: current.id,
            lines,
            accountId,
            companyId,
            postedAt: expenseDateToPostedAt(asOfDate),
          });
          return c.json(updated);
        }

        const id = uuidv7();
        const [created] = await tx
          .insert(openingBalances)
          .values({ id, accountId, companyId, asOfDate, shape, ...figures })
          .returning();
        await tx.insert(openingBalanceLines).values(
          lines.map((l) => ({
            id: uuidv7(),
            accountId,
            openingBalanceId: id,
            coaAccountId: l.coaAccountId,
            side: l.side,
            amount: l.amount,
          })),
        );
        await c.var.audit({
          entityType: 'opening_balance',
          entityId: id,
          action: 'create',
          after: { ...created, lines },
          companyId,
        });
        await postOpeningBalance(tx, {
          openingBalanceId: id,
          lines,
          accountId,
          companyId,
          postedAt: expenseDateToPostedAt(asOfDate),
        });
        return c.json(created, 201);
      })
      .delete(
        '/api/owner-money/opening-balance',
        requireCapability('expenses:write'),
        async (c) => {
          const tx = c.get('tx');
          const accountId = c.get('accountId');
          const companyId = c.req.query('companyId');
          if (!companyId || !UUID_RE.test(companyId)) {
            return c.json({ error: 'invalid_company_id' }, 400);
          }
          const [current] = await tx
            .select()
            .from(openingBalances)
            .where(
              and(
                eq(openingBalances.accountId, accountId),
                eq(openingBalances.companyId, companyId),
                isNull(openingBalances.deletedAt),
              ),
            )
            .limit(1);
          if (!current) return c.json({ error: 'opening_balance_not_found' }, 404);

          const now = new Date();
          const [deleted] = await tx
            .update(openingBalances)
            .set({ deletedAt: now, updatedAt: now })
            .where(
              and(eq(openingBalances.id, current.id), eq(openingBalances.accountId, accountId)),
            )
            .returning();
          await c.var.audit({
            entityType: 'opening_balance',
            entityId: current.id,
            action: 'delete',
            before: current,
            after: deleted,
            companyId,
          });
          // Soft delete keeps history; the reversal nets the GL to zero. Built
          // from the stored lines, so it undoes exactly what was posted whatever
          // shape it was entered in. The line rows are left in place — they're
          // the evidence of what the reversal reversed.
          const priorLines = await tx
            .select({
              coaAccountId: openingBalanceLines.coaAccountId,
              side: openingBalanceLines.side,
              amount: openingBalanceLines.amount,
            })
            .from(openingBalanceLines)
            .where(
              and(
                eq(openingBalanceLines.accountId, accountId),
                eq(openingBalanceLines.openingBalanceId, current.id),
              ),
            );
          await postOpeningBalanceReversal(tx, {
            openingBalanceId: current.id,
            lines: priorLines.map((l) => ({
              coaAccountId: l.coaAccountId,
              side: l.side as 'debit' | 'credit',
              amount: l.amount,
            })),
            accountId,
            companyId,
            postedAt: expenseDateToPostedAt(current.asOfDate),
          });
          return c.json(deleted);
        },
      )
      .get('/api/owner-money/:id', async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const [event] = await tx
          .select()
          .from(ownerMoneyEvents)
          .where(and(eq(ownerMoneyEvents.id, id), eq(ownerMoneyEvents.accountId, accountId)))
          .limit(1);
        if (!event || event.deletedAt) return c.json({ error: 'owner_money_event_not_found' }, 404);
        return c.json(event);
      })
      .patch(
        '/api/owner-money/:id',
        requireCapability('expenses:write'),
        validator('json', (value, c) => {
          const parsed = ownerMoneyEventUpdateSchema.safeParse(value);
          if (!parsed.success) {
            return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
          }
          return parsed.data;
        }),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
          const data = c.req.valid('json');

          const tx = c.get('tx');
          const accountId = c.get('accountId');

          const [current] = await tx
            .select()
            .from(ownerMoneyEvents)
            .where(and(eq(ownerMoneyEvents.id, id), eq(ownerMoneyEvents.accountId, accountId)))
            .limit(1);
          if (!current || current.deletedAt) {
            return c.json({ error: 'owner_money_event_not_found' }, 404);
          }

          // Sparse merge; companyId is immutable (omitted from the schema).
          const next = {
            kind: data.kind ?? (current.kind as OwnerMoneyEventKind),
            amount: data.amount ?? current.amount,
            occurredOn: data.occurredOn ?? current.occurredOn,
            memo: data.memo !== undefined ? data.memo : current.memo,
          };

          // Edit = reverse the prior posting (old kind/amount at the old date) +
          // repost the new one. Keeps the GL append-only.
          await postOwnerMoneyEventReversal(tx, {
            event: { id, kind: current.kind as OwnerMoneyEventKind, amount: current.amount },
            accountId,
            companyId: current.companyId,
            postedAt: expenseDateToPostedAt(current.occurredOn),
          });

          const [updated] = await tx
            .update(ownerMoneyEvents)
            .set({
              kind: next.kind,
              amount: next.amount,
              occurredOn: next.occurredOn,
              memo: next.memo ?? null,
              updatedAt: new Date(),
            })
            .where(and(eq(ownerMoneyEvents.id, id), eq(ownerMoneyEvents.accountId, accountId)))
            .returning();
          if (!updated) return c.json({ error: 'owner_money_event_not_found' }, 404);

          await c.var.audit({
            entityType: 'owner_money_event',
            entityId: id,
            action: 'update',
            before: current,
            after: updated,
            companyId: current.companyId,
          });

          await postOwnerMoneyEvent(tx, {
            event: { id, kind: next.kind, amount: next.amount },
            accountId,
            companyId: current.companyId,
            postedAt: expenseDateToPostedAt(next.occurredOn),
          });

          return c.json(updated);
        },
      )
      .delete('/api/owner-money/:id', requireCapability('expenses:write'), async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        const tx = c.get('tx');
        const accountId = c.get('accountId');

        const [current] = await tx
          .select()
          .from(ownerMoneyEvents)
          .where(and(eq(ownerMoneyEvents.id, id), eq(ownerMoneyEvents.accountId, accountId)))
          .limit(1);
        if (!current || current.deletedAt) {
          return c.json({ error: 'owner_money_event_not_found' }, 404);
        }

        const now = new Date();
        const [deleted] = await tx
          .update(ownerMoneyEvents)
          .set({ deletedAt: now, updatedAt: now })
          .where(and(eq(ownerMoneyEvents.id, id), eq(ownerMoneyEvents.accountId, accountId)))
          .returning();
        if (!deleted) return c.json({ error: 'owner_money_event_not_found' }, 404);

        await c.var.audit({
          entityType: 'owner_money_event',
          entityId: id,
          action: 'delete',
          before: current,
          after: deleted,
          companyId: current.companyId,
        });

        // Soft delete keeps the row for history (deleted_at) but reverses the
        // original posting so the GL nets to zero for this event.
        await postOwnerMoneyEventReversal(tx, {
          event: { id, kind: current.kind as OwnerMoneyEventKind, amount: current.amount },
          accountId,
          companyId: current.companyId,
          postedAt: expenseDateToPostedAt(current.occurredOn),
        });

        return c.json(deleted);
      })
  );
}

export type OwnerMoneyEventsAppType = ReturnType<typeof ownerMoneyRoutes>;

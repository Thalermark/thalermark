import { companies, ownerMoneyEvents } from '@thalermark/db';
import {
  type OwnerMoneyEventKind,
  ownerMoneyEventCreateSchema,
  ownerMoneyEventUpdateSchema,
} from '@thalermark/validation';
import { and, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { v7 as uuidv7 } from 'uuid';
import { postOwnerMoneyEvent, postOwnerMoneyEventReversal } from '../lib/ledger.js';
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
  return new Hono<{ Variables: RlsVariables }>()
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
    });
}

export type OwnerMoneyEventsAppType = ReturnType<typeof ownerMoneyRoutes>;

import {
  auditEvents,
  authUser,
  bills,
  contacts,
  estimates,
  expenses,
  invoices,
  items,
  journalEntries,
  ownerMoneyEvents,
  recurringInvoices,
} from '@thalermark/db';
import { and, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { applyCursor, keysetOrderBy, parseLimit, slicePage } from '../lib/pagination.js';
import { UUID_RE } from '../lib/route-helpers.js';
import type { RlsVariables } from '../middleware/rls-context.js';

// audit-events — the audit-events read endpoint. Two modes off the same surface:
//   - **Per-entity** (entityType + entityId): full history for one record; used
//     by the per-entity History sections on customer/invoice/estimate detail
//     pages (slice 8.8a).
//   - **Feed** (both omitted): account-wide recent activity, used by the
//     /activity page (slice 8.8b). Bounded by `limit` (default 50, max 200) so a
//     hot account doesn't ship the entire audit table.
// Both modes resolve actor_user_id → display name in one join; the synthetic
// system user (auth_user.is_system, seeded migration 0009) renders as "System"
// so provider-driven rows (stripe-paid, public-accept/decline) are attributed
// without leaking the system uuid. Feed mode additionally enriches each row with
// `entityLabel` — invoice/estimate `number` or customer `name` — via one inArray
// lookup per entity type (3 small queries, not N+1) so the feed UI can render
// "Invoice INV-0042" without the consumer doing per-row resolution. A deps-free
// pure-tenant sub-app (cf. items/tax-policies); mounted on createApp via
// .route() so its schema rides on its own AuditEventsAppType instead of bloating
// AppType past TS7056.
export function auditEventsRoutes() {
  return new Hono<{ Variables: RlsVariables }>().get('/api/audit-events', async (c) => {
    const entityTypeRaw = c.req.query('entityType');
    const entityIdRaw = c.req.query('entityId');
    const limitRaw = c.req.query('limit');
    const ALLOWED_TYPES = [
      'contact',
      'invoice',
      'estimate',
      'expense',
      'bill',
      'owner_money_event',
      'opening_balance',
      'manual_adjustment',
      'recurring_invoice',
      'item',
    ] as const;
    type EntityType = (typeof ALLOWED_TYPES)[number];

    // Validation: entityId requires entityType (a bare id is ambiguous);
    // entityType alone is allowed but rare. Empty query = feed mode.
    if (entityTypeRaw !== undefined) {
      if (!(ALLOWED_TYPES as readonly string[]).includes(entityTypeRaw)) {
        return c.json({ error: 'invalid_entity_type' }, 400);
      }
    }
    if (entityIdRaw !== undefined) {
      if (entityTypeRaw === undefined) {
        return c.json({ error: 'entity_id_requires_entity_type' }, 400);
      }
      if (!UUID_RE.test(entityIdRaw)) {
        return c.json({ error: 'invalid_entity_id' }, 400);
      }
    }
    const limit = parseLimit(limitRaw);
    if (limit === null) return c.json({ error: 'invalid_limit' }, 400);
    const keys = [
      { col: auditEvents.createdAt, revive: (v: unknown) => new Date(v as string) },
      { col: auditEvents.id },
    ];
    const keyset = applyCursor(c.req.query('cursor'), keys, 'desc');
    if (keyset === 'invalid') return c.json({ error: 'invalid_cursor' }, 400);

    const tx = c.get('tx');
    const accountId = c.get('accountId');

    const conditions = [eq(auditEvents.accountId, accountId)];
    if (entityTypeRaw !== undefined) {
      conditions.push(eq(auditEvents.entityType, entityTypeRaw));
    }
    if (entityIdRaw !== undefined) {
      conditions.push(eq(auditEvents.entityId, entityIdRaw));
    }
    if (keyset) conditions.push(keyset);

    const fetched = await tx
      .select({
        id: auditEvents.id,
        action: auditEvents.action,
        entityType: auditEvents.entityType,
        entityId: auditEvents.entityId,
        actorName: authUser.name,
        actorIsSystem: authUser.isSystem,
        createdAt: auditEvents.createdAt,
        before: auditEvents.before,
        after: auditEvents.after,
      })
      .from(auditEvents)
      .leftJoin(authUser, eq(authUser.id, auditEvents.actorUserId))
      .where(and(...conditions))
      .orderBy(keysetOrderBy(keys, 'desc'))
      .limit(limit + 1);
    const { rows, nextCursor } = slicePage(fetched, limit, (r) => [r.createdAt, r.id]);

    // Entity-label enrichment — feed mode needs human labels next to
    // the action; per-entity mode already knows the entity. Skip the
    // lookups when no rows came back to dodge zero-id `inArray`.
    const feedMode = entityTypeRaw === undefined;
    const labelMap = new Map<string, string>();
    if (feedMode && rows.length > 0) {
      const idsByType: Record<EntityType, string[]> = {
        contact: [],
        invoice: [],
        estimate: [],
        expense: [],
        bill: [],
        owner_money_event: [],
        opening_balance: [],
        manual_adjustment: [],
        recurring_invoice: [],
        item: [],
      };
      for (const r of rows) {
        if ((ALLOWED_TYPES as readonly string[]).includes(r.entityType)) {
          idsByType[r.entityType as EntityType].push(r.entityId);
        }
      }
      if (idsByType.invoice.length > 0) {
        const invRows = await tx
          .select({ id: invoices.id, label: invoices.number })
          .from(invoices)
          .where(and(eq(invoices.accountId, accountId), inArray(invoices.id, idsByType.invoice)));
        for (const r of invRows) labelMap.set(`invoice:${r.id}`, r.label);
      }
      if (idsByType.estimate.length > 0) {
        const estRows = await tx
          .select({ id: estimates.id, label: estimates.number })
          .from(estimates)
          .where(
            and(eq(estimates.accountId, accountId), inArray(estimates.id, idsByType.estimate)),
          );
        for (const r of estRows) labelMap.set(`estimate:${r.id}`, r.label);
      }
      if (idsByType.contact.length > 0) {
        const contactRows = await tx
          .select({ id: contacts.id, label: contacts.name })
          .from(contacts)
          .where(and(eq(contacts.accountId, accountId), inArray(contacts.id, idsByType.contact)));
        for (const r of contactRows) labelMap.set(`contact:${r.id}`, r.label);
      }
      if (idsByType.expense.length > 0) {
        const expRows = await tx
          .select({ id: expenses.id, label: expenses.merchant })
          .from(expenses)
          .where(and(eq(expenses.accountId, accountId), inArray(expenses.id, idsByType.expense)));
        for (const r of expRows) labelMap.set(`expense:${r.id}`, r.label);
      }
      // Bills have no number of our own — label them by the vendor name
      // (joined), like recurring schedules.
      if (idsByType.bill.length > 0) {
        const billRows = await tx
          .select({ id: bills.id, label: contacts.name })
          .from(bills)
          .innerJoin(contacts, eq(contacts.id, bills.contactId))
          .where(and(eq(bills.accountId, accountId), inArray(bills.id, idsByType.bill)));
        for (const r of billRows) labelMap.set(`bill:${r.id}`, r.label);
      }
      // Owner money events have no number/name — label them by kind in plain
      // language ("Money in" / "Money out"), matching the user-facing copy.
      if (idsByType.owner_money_event.length > 0) {
        const omeRows = await tx
          .select({ id: ownerMoneyEvents.id, kind: ownerMoneyEvents.kind })
          .from(ownerMoneyEvents)
          .where(
            and(
              eq(ownerMoneyEvents.accountId, accountId),
              inArray(ownerMoneyEvents.id, idsByType.owner_money_event),
            ),
          );
        for (const r of omeRows) {
          labelMap.set(
            `owner_money_event:${r.id}`,
            r.kind === 'contribution' ? 'Money in' : 'Money out',
          );
        }
      }
      // Opening balances have a single label regardless of the row — no lookup.
      for (const id of idsByType.opening_balance) {
        labelMap.set(`opening_balance:${id}`, 'Starting balances');
      }
      // Manual journal adjustments are journal_entries rows (no domain table) —
      // label them by the entry's memo (the user's narrative), falling back to
      // a generic handle if somehow blank.
      if (idsByType.manual_adjustment.length > 0) {
        const jeRows = await tx
          .select({ id: journalEntries.id, memo: journalEntries.memo })
          .from(journalEntries)
          .where(
            and(
              eq(journalEntries.accountId, accountId),
              inArray(journalEntries.id, idsByType.manual_adjustment),
            ),
          );
        for (const r of jeRows) {
          labelMap.set(`manual_adjustment:${r.id}`, r.memo ?? 'Journal entry');
        }
      }
      // Schedules have no number — label them by customer name (joined).
      if (idsByType.recurring_invoice.length > 0) {
        const recRows = await tx
          .select({ id: recurringInvoices.id, label: contacts.name })
          .from(recurringInvoices)
          .innerJoin(contacts, eq(contacts.id, recurringInvoices.contactId))
          .where(
            and(
              eq(recurringInvoices.accountId, accountId),
              inArray(recurringInvoices.id, idsByType.recurring_invoice),
            ),
          );
        for (const r of recRows) labelMap.set(`recurring_invoice:${r.id}`, r.label);
      }
      if (idsByType.item.length > 0) {
        const itemRows = await tx
          .select({ id: items.id, label: items.name })
          .from(items)
          .where(and(eq(items.accountId, accountId), inArray(items.id, idsByType.item)));
        for (const r of itemRows) labelMap.set(`item:${r.id}`, r.label);
      }
    }

    return c.json({
      events: rows.map((r) => ({
        id: r.id,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        entityLabel: feedMode ? (labelMap.get(`${r.entityType}:${r.entityId}`) ?? null) : null,
        actorName: r.actorIsSystem ? 'System' : (r.actorName ?? 'Unknown'),
        createdAt: r.createdAt,
        before: r.before,
        after: r.after,
      })),
      nextCursor,
    });
  });
}

export type AuditEventsAppType = ReturnType<typeof auditEventsRoutes>;

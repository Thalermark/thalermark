import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts.js';
import { authUser } from './auth.js';
import { companies } from './companies.js';

// Append-only audit log. RLS forbids UPDATE and DELETE; see migration 0009.
// `entity_id` is intentionally not a foreign key — the table is polymorphic
// across all domain entities. `entity_type` records which table the id refers
// to (e.g. 'invoice', 'expense', 'customer').
//
// For system-initiated mutations (recurring invoice jobs, Stripe webhooks)
// the actor is the synthetic system user seeded in migration 0009
// (auth_user.is_system = true), so this column stays NOT NULL.
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    companyId: uuid('company_id').references(() => companies.id),
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => authUser.id),
    // The actor's display name AS IT WAS when the row was written. The read
    // prefers the live name off auth_user and falls back to this, so a rename
    // still shows through history for someone who is still here, while a deleted
    // profile pins to the name that was true at the time. Without it, a workspace
    // whose helpers come and go fills up with "Unknown" and stops answering the
    // one question an audit trail exists to answer (TMC-268).
    actorName: text('actor_name'),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    action: text('action').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Backs the activity feed keyset: WHERE account_id ORDER BY created_at DESC, id DESC.
    accountCreatedAtIdx: index('audit_events_account_created_at_idx').on(
      table.accountId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    entityIdx: index('audit_events_entity_idx').on(table.entityType, table.entityId),
  }),
);

export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;

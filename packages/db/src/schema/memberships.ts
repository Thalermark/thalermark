import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts.js';
import { authUser } from './auth.js';

export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    // Authorization role within the workspace (see packages/validation roles.ts
    // for the capability matrix). 'owner' = the workspace creator, PROTECTED:
    // cannot be removed or leave (that would orphan the workspace) and is
    // reachable only via the transfer-ownership flow. The other four
    // (admin/member/accountant/viewer) are assignable by invite or role change.
    // Roles are enforced in the app layer (the rls-context probe loads this into
    // request context, then `requireCapability` gates mutating routes); RLS stays
    // isolation-only. The partial unique index caps it at one owner per account.
    // account (code) == Workspace (UI).
    role: text('role').notNull().default('member'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userAccountIdx: uniqueIndex('memberships_user_account_idx').on(table.userId, table.accountId),
    accountIdIdx: index('memberships_account_id_idx').on(table.accountId),
    // At most one owner per account — structurally guarantees the protected
    // creator is unique (and, since the signup hook always seeds one and the
    // owner can't be removed, always present). Partial unique index.
    oneOwnerPerAccount: uniqueIndex('memberships_one_owner_per_account')
      .on(table.accountId)
      .where(sql`role = 'owner'`),
    roleCheck: check(
      'memberships_role_check',
      sql`role in ('owner', 'admin', 'member', 'accountant', 'viewer')`,
    ),
  }),
);

export type Membership = typeof memberships.$inferSelect;
export type NewMembership = typeof memberships.$inferInsert;

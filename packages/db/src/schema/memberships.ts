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
    // 'owner' = the workspace creator, who is PROTECTED: an owner cannot be
    // removed by anyone else and cannot leave (leaving would orphan the
    // workspace). 'member' = everyone else (invited teammates), who can be
    // removed and can leave. MVP grants both roles the same access — the role
    // only drives the owner-protection guards today; v1.1 extends the CHECK
    // below with granular roles (admin/accountant/viewer). The partial unique
    // index caps it at one owner per account. account (code) == Workspace (UI).
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
    roleCheck: check('memberships_role_check', sql`role in ('owner', 'member')`),
  }),
);

export type Membership = typeof memberships.$inferSelect;
export type NewMembership = typeof memberships.$inferInsert;

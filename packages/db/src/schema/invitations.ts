import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts.js';
import { authUser } from './auth.js';

// Pending and historical email invitations to join an account. The invitee
// matches by `email` at accept time (authed Better Auth session), not by
// user_id (the user may not exist yet at create time). RLS scopes
// SELECT/INSERT/UPDATE to the inviting account; the accept endpoint runs
// outside RLS context (bootstrap pattern, see apps/api rls-context middleware)
// because the accepting user is not yet a member of the account.
export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    // The workspace role the invitee receives on accept (carried to the
    // memberships row in both the accept handler and the invited-signup hook).
    // Owner is excluded — you become owner only via the transfer-ownership flow.
    role: text('role').notNull().default('member'),
    token: text('token').notNull().unique(),
    invitedByUserId: uuid('invited_by_user_id')
      .notNull()
      .references(() => authUser.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedByUserId: uuid('accepted_by_user_id').references(() => authUser.id, {
      onDelete: 'set null',
    }),
    // Set when the invitee declines via POST /api/invitations/:token/decline.
    // Mutually exclusive with acceptedAt in practice; a declined invite is
    // terminal (accept/auto-join skip it). Lets the inviter see the outcome on
    // the team page instead of the invite silently lingering as "pending".
    declinedAt: timestamp('declined_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountIdIdx: index('invitations_account_id_idx').on(table.accountId),
    emailIdx: index('invitations_email_idx').on(table.email),
    roleCheck: check(
      'invitations_role_check',
      sql`role in ('admin', 'member', 'accountant', 'viewer')`,
    ),
  }),
);

export type Invitation = typeof invitations.$inferSelect;
export type NewInvitation = typeof invitations.$inferInsert;

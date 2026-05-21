import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
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
    token: text('token').notNull().unique(),
    invitedByUserId: uuid('invited_by_user_id')
      .notNull()
      .references(() => authUser.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedByUserId: uuid('accepted_by_user_id').references(() => authUser.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountIdIdx: index('invitations_account_id_idx').on(table.accountId),
    emailIdx: index('invitations_email_idx').on(table.email),
  }),
);

export type Invitation = typeof invitations.$inferSelect;
export type NewInvitation = typeof invitations.$inferInsert;

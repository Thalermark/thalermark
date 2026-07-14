import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts.js';
import { authUser } from './auth.js';

// Legal-consent acceptances — a per-PERSON, per-VERSION record that a user
// accepted the deployment's Terms + Privacy at the sign-up clickwrap gate.
// Unlike almost every other table this is USER-scoped, not account-tenanted:
// the human is the party bound, and one person joining several accounts on the
// same deployment accepted the same terms once. `account_id` is captured only
// as context (which tenant they were in at accept time), never as the key.
// Append-only, like audit_events — an acceptance is a historical fact, not
// something that gets edited; there is deliberately no updated_at.
//
// Read + written via the bootstrap (RLS-bypass) handle, the same path /api/me
// and invitation accept use for user-scoped work that runs before an account
// context exists. RLS is still enabled in the migration (defense-in-depth),
// keyed on the `app.current_user_id` GUC — the memberships_user_self_select
// precedent — so any future app-role access is fenced too. `ip` / `user_agent`
// stay null on the public build; the commercial layer fills them for its
// heightened evidentiary record.
export const legalAcceptances = pgTable(
  'legal_acceptances',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    termsVersion: text('terms_version').notNull(),
    termsUrl: text('terms_url').notNull(),
    privacyVersion: text('privacy_version').notNull(),
    privacyUrl: text('privacy_url').notNull(),
    // Context only — which tenant the person was in when they accepted. Nullable
    // because acceptance can precede account selection; on delete of the account
    // the record survives (set null), since the person's acceptance still stands.
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    // Commercial-only enrichment; the public build leaves these null.
    ip: text('ip'),
    userAgent: text('user_agent'),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdIdx: index('legal_acceptances_user_id_idx').on(table.userId),
    // Idempotent re-acceptance: one row per (person, terms+privacy version). A
    // second click of the same version is an on-conflict no-op; bumping either
    // version writes a fresh row.
    userVersionUq: uniqueIndex('legal_acceptances_user_version_uq').on(
      table.userId,
      table.termsVersion,
      table.privacyVersion,
    ),
  }),
);

export type LegalAcceptance = typeof legalAcceptances.$inferSelect;
export type NewLegalAcceptance = typeof legalAcceptances.$inferInsert;

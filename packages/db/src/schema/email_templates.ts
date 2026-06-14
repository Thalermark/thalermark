import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts.js';
import { companies } from './companies.js';

// Per-company overrides for the customer-facing emails (invoice / estimate /
// statement). A row exists ONLY when a business has customized that type — the
// default copy lives in code (apps/api/src/lib/email-templates.ts), so an empty
// table is the correct zero-config state and self-host needs no seeding. The
// send path resolves override-or-default by (company_id, type).
//
// `subject` + `body` are plain text with {{placeholders}} (see
// @thalermark/validation EMAIL_TEMPLATE_PLACEHOLDERS); the api substitutes the
// allowed tokens and renders `body` into the fixed branded shell. Users never
// author HTML — escaping stays ours. account_id is denormalized for the
// standard NULLIF RLS idiom; (company_id, type) is unique — one override per
// type per company. `type` is an app-enforced enum (no CHECK; matches the
// businessType precedent on companies).
export const emailTemplates = pgTable(
  'email_templates',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountIdIdx: index('email_templates_account_id_idx').on(table.accountId),
    companyTypeUq: uniqueIndex('email_templates_company_type_uq').on(table.companyId, table.type),
  }),
);

export type EmailTemplate = typeof emailTemplates.$inferSelect;
export type NewEmailTemplate = typeof emailTemplates.$inferInsert;

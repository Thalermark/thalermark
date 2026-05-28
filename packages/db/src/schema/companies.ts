import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts.js';

export const companies = pgTable(
  'companies',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // Business entity type — picked at company creation; drives which
    // chart-of-accounts gets seeded and which tax reports surface. MVP
    // seeds the sole-prop COA regardless of value (other types fall
    // back to sole-prop until v1.x adds their seeds + reports). Null
    // is treated as 'sole_prop' by the application layer so pre-ledger
    // rows keep working. Allowed values enforced at the app layer for
    // now; CHECK constraint deferred until the wizard slice locks the
    // enum.
    businessType: text('business_type'),
    // Stripe Connect (SaaS multi-tenant payment routing). Lazily populated
    // when the company owner kicks off onboarding from /settings/payments —
    // self-host operators using a single STRIPE_SECRET_KEY leave these null
    // and the 8.5c self-host pay flow remains correct for them.
    // charges_enabled is the gate for whether 8.5e routes payments to this
    // connected account; details_submitted surfaces the "review in progress"
    // intermediate state Stripe puts a freshly-onboarded account in.
    stripeConnectAccountId: text('stripe_connect_account_id'),
    stripeConnectChargesEnabled: boolean('stripe_connect_charges_enabled').notNull().default(false),
    stripeConnectDetailsSubmitted: boolean('stripe_connect_details_submitted')
      .notNull()
      .default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountIdIdx: index('companies_account_id_idx').on(table.accountId),
    stripeConnectAccountIdUq: uniqueIndex('companies_stripe_connect_account_id_uq').on(
      table.stripeConnectAccountId,
    ),
  }),
);

export type Company = typeof companies.$inferSelect;
export type NewCompany = typeof companies.$inferInsert;

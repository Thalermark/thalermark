import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
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
    // Cash-flow nudges (AI insight) cache. The reasoning-role LLM writes
    // plain-English nudges from deterministic ledger signals; we cache them
    // here so the dashboard doesn't re-run the model on every view.
    // nudges_input_hash is a hash of those signals — the route regenerates only
    // when it changes (new transactions, a newly-overdue invoice, a month
    // rollover), so invalidation is input-driven with no TTL. All null until
    // the first generation. JIT note: when a second cached insight (anomaly /
    // late-payer) lands, promote these to a company_insights table keyed by type.
    cashFlowNudges: jsonb('cash_flow_nudges'),
    nudgesInputHash: text('nudges_input_hash'),
    nudgesGeneratedAt: timestamp('nudges_generated_at', { withTimezone: true }),
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

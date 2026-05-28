import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts.js';
import { companies } from './companies.js';

// Chart of accounts. One row per ledger account per company; seeded by the
// signup hook (sole-prop COA for the default company) and re-seeded when an
// operator adds another company. Codes follow the 4-digit convention every
// accountant recognises: 1000s assets, 2000s liabilities, 3000s equity,
// 4000s revenue, 5000s+ expenses (Schedule C buckets in 6000–7900). The
// numeric coding lets the GL export drop straight into a standard trial
// balance; tax_mapping carries the Schedule C / Form 1120 line so the
// accountant-handoff export can group by tax line without us hardcoding
// the mapping in application code.
//
// account_id is the tenant denorm (NULLIF RLS idiom — uniform with the rest
// of the schema, dodges a join on every policy check). company_id scopes
// the chart to the right business; a second company on the same account
// gets its own COA seed.
//
// account_type is one of: 'asset' | 'liability' | 'equity' | 'revenue' |
// 'expense'. normal_balance is the side a positive balance lives on
// ('debit' for assets + expenses, 'credit' for liabilities + equity +
// revenue) — denormalised so report code doesn't re-derive it on every
// query. Both are text + CHECK in the migration rather than pgEnum to
// stay uniform with invoice/estimate status.
export const chartOfAccounts = pgTable(
  'chart_of_accounts',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    accountType: text('account_type').notNull(),
    normalBalance: text('normal_balance').notNull(),
    taxMapping: text('tax_mapping'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountIdIdx: index('chart_of_accounts_account_id_idx').on(table.accountId),
    companyIdIdx: index('chart_of_accounts_company_id_idx').on(table.companyId),
    companyCodeUq: uniqueIndex('chart_of_accounts_company_code_uq').on(table.companyId, table.code),
  }),
);

export type ChartOfAccount = typeof chartOfAccounts.$inferSelect;
export type NewChartOfAccount = typeof chartOfAccounts.$inferInsert;

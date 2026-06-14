import { boolean, index, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts.js';
import { companies } from './companies.js';

// A per-company set of reusable tax policies (named sales-tax rates) — the
// source behind the per-item "taxable" decision and the per-line tax snapshot.
// Mirrors items in shape: company-scoped, account_id denormalized for the
// standard NULLIF RLS idiom, archive (never hard-delete).
//
// rate_pct is a percentage (e.g. '8.2500' = 8.25%), numeric(7,4) so rates like
// 8.8750% round-trip exactly. A line that picks a policy *copies* the rate onto
// itself (invoice_line_items.tax_rate_pct + tax_amount are stored snapshots) so
// editing or archiving a policy never rewrites a sent invoice — same
// snapshot-not-reference philosophy as items / source_item_id. The line's
// nullable tax_policy_id FK is purely a reporting breadcrumb.
//
// is_default marks the policy auto-applied to new taxable lines / ad-hoc lines.
// At most one policy per company is the default — the app clears the others in
// the same tx when one is set (no DB constraint; matches the app-enforced
// single-default pattern used elsewhere).
//
// Policies archive (archived_at drops them out of the picker) rather than
// hard-delete, so the tax_policy_id breadcrumbs on historical lines never get
// orphaned. There is no DELETE endpoint — archive/restore transitions instead.
export const taxPolicies = pgTable(
  'tax_policies',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    ratePct: numeric('rate_pct', { precision: 7, scale: 4 }).notNull().default('0'),
    isDefault: boolean('is_default').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountIdIdx: index('tax_policies_account_id_idx').on(table.accountId),
    companyIdIdx: index('tax_policies_company_id_idx').on(table.companyId),
    // Plain (not unique) — policy names can repeat across companies; scoped to a
    // single company in every query.
    companyNameIdx: index('tax_policies_company_name_idx').on(table.companyId, table.name),
    // Backs the keyset policy list: WHERE account_id ORDER BY name ASC, id ASC.
    accountNameIdx: index('tax_policies_account_name_idx').on(
      table.accountId,
      table.name,
      table.id,
    ),
  }),
);

export type TaxPolicy = typeof taxPolicies.$inferSelect;
export type NewTaxPolicy = typeof taxPolicies.$inferInsert;

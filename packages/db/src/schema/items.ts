import { index, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts.js';
import { companies } from './companies.js';

// A per-company catalog of saved line items (products & services) — the
// reusable source behind the line-item type-ahead and the top-products report.
// Mirrors customers in shape: company-scoped, account_id denormalized for the
// standard NULLIF RLS idiom.
//
// Picking an item *copies* description / unit_price / default_quantity onto a
// line; the line stays a free-text snapshot (invoice_line_items.amount is a
// stored column for the same reason — historical totals must be reproducible).
// Editing or archiving an item never rewrites a sent invoice. The line's
// nullable source_item_id FK (added to the three line-item tables in the same
// migration) is purely a reporting breadcrumb — displayed values always come
// from the snapshot.
//
// Items archive, never hard-delete: archived_at drops a row out of the picker
// (WHERE archived_at IS NULL) while keeping the FK + sales history intact so
// the top-products report never gets holes punched in it. There is no DELETE
// endpoint — archive/restore transitions instead. (Contrast customers'
// RESTRICT-on-delete; items reach the same "never lose history" end via archive
// because a delete would orphan the report.)
//
// unit_price defaults to '0' (a service may be priced per-job at line time);
// default_quantity defaults to '1'. unit_label is a free-text display unit
// ("hour", "sq ft") that the picker can surface — no enforced enum.
export const items = pgTable(
  'items',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    unitPrice: numeric('unit_price', { precision: 15, scale: 2 }).notNull().default('0'),
    unitLabel: text('unit_label'),
    defaultQuantity: numeric('default_quantity', { precision: 15, scale: 4 })
      .notNull()
      .default('1'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountIdIdx: index('items_account_id_idx').on(table.accountId),
    companyIdIdx: index('items_company_id_idx').on(table.companyId),
    // Plain (not unique) — item names repeat. Backs the autocomplete ILIKE,
    // which is always scoped to a single company.
    companyNameIdx: index('items_company_name_idx').on(table.companyId, table.name),
    // Backs the keyset catalog list: WHERE account_id ORDER BY name ASC, id ASC.
    accountNameIdx: index('items_account_name_idx').on(table.accountId, table.name, table.id),
  }),
);

export type Item = typeof items.$inferSelect;
export type NewItem = typeof items.$inferInsert;

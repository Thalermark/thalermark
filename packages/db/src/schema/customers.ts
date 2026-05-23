import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts.js';
import { companies } from './companies.js';

// Customers belong to a specific company within an account. Address is stored
// as flat fields, populated by the Mapbox / Nominatim autocomplete that will
// land alongside the customer-creation UI (packages/location, deferred per
// SCAFFOLDING.md §Phase 4). Tax-id / exemption columns are intentionally
// absent in MVP — compliance is a pluggable module, not a table column.
export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    email: text('email'),
    phone: text('phone'),
    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    city: text('city'),
    region: text('region'),
    postalCode: text('postal_code'),
    country: text('country'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountIdIdx: index('customers_account_id_idx').on(table.accountId),
    companyIdIdx: index('customers_company_id_idx').on(table.companyId),
    nameIdx: index('customers_name_idx').on(table.name),
    emailIdx: index('customers_email_idx').on(table.email),
  }),
);

export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;

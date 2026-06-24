import { boolean, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts.js';
import { companies } from './companies.js';

// Contacts belong to a specific company within an account. One contact record
// can act as a customer (is_customer), a vendor (is_vendor), or both — the
// Xero-style unified model, since for trades/freelancers the same business is
// frequently both who you sell to and who you buy from. Document type implies
// the role: invoices/estimates/recurring point at a contact as the customer;
// expenses point at a contact as the vendor (see CONTACTS-AND-AP spike).
//
// Address is stored as flat fields, populated by the Mapbox / Census
// autocomplete. Tax-id / exemption / payment-terms columns are intentionally
// absent — compliance is a pluggable module and the AP/1099 vendor fields land
// with the bills feature, not here.
export const contacts = pgTable(
  'contacts',
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
    // Role flags. A contact defaults to a customer (the prior behavior — every
    // existing row was a customer); is_vendor is opt-in and surfaces on the
    // expense vendor link. Both are plain booleans, not mutually exclusive.
    isCustomer: boolean('is_customer').notNull().default(true),
    isVendor: boolean('is_vendor').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountIdIdx: index('contacts_account_id_idx').on(table.accountId),
    companyIdIdx: index('contacts_company_id_idx').on(table.companyId),
    nameIdx: index('contacts_name_idx').on(table.name),
    emailIdx: index('contacts_email_idx').on(table.email),
    // Backs the keyset list query: WHERE account_id ORDER BY created_at DESC, id DESC.
    accountCreatedAtIdx: index('contacts_account_created_at_idx').on(
      table.accountId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
  }),
);

export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;

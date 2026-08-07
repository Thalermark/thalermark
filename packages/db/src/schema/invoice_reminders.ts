import {
  bigint,
  date,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { accounts } from './accounts.js';
import { companies } from './companies.js';
import { invoices } from './invoices.js';

// One row per reminder actually sent (TMC-189). This table IS the idempotency
// mechanism, not a log kept beside one.
//
// WHY A UNIQUE CONSTRAINT RATHER THAN A "reminded" FLAG. The sweep runs on
// pg-boss, and pg-boss retries. A boolean column set after a successful send
// leaves a window where the mail went out and the flag did not land — the retry
// then sends the same chase again, to the customer of the person using this
// software. Inserting the row in the SAME transaction as the send, behind a
// unique index on (invoice, offset), makes a double-send a constraint violation
// instead of a second email. Same discipline as the Stripe webhook's unique
// index on payment_intent_id: the database is the only thing that holds under a
// race.
//
// OFFSET IS THE STAGE IDENTITY. A company's schedule is a list of day offsets
// relative to the due date (-5 = five days before, 7 = a week after), so the
// offset uniquely names which reminder in the schedule this was. Storing the
// offset rather than an ordinal means re-ordering or editing the schedule can
// never make an already-sent stage look unsent — remove the +7 and add it back
// and it still will not fire twice.
export const invoiceReminders = pgTable(
  'invoice_reminders',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    // CASCADE, same reasoning as invoice_payments: a reminder about an invoice
    // that no longer exists is not a record worth keeping.
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    // Days relative to the invoice due date. Negative = before it falls due,
    // positive = after. Zero is "on the day". Signed on purpose — the UI splits
    // it into "before it's due" and "after it's due" so nobody types a minus
    // sign, exactly as the refund direction toggle avoids one.
    offsetDays: bigint('offset_days', { mode: 'number' }).notNull(),
    // The calendar date the reminder was sent, in the COMPANY's timezone. A
    // bare date, like invoice_payments.received_on: "sent on the 14th" must not
    // drift across a timezone boundary.
    sentOn: date('sent_on', { mode: 'string' }).notNull(),
    // What the customer was actually told they owed, captured at send time.
    // Not derivable afterwards — a later payment changes the outstanding
    // balance, and "what did we chase them for" is exactly the question that
    // gets asked when a customer disputes a reminder.
    outstanding: text('outstanding').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The guarantee. Send exactly once per stage, per invoice, forever.
    uniqueIndex('invoice_reminders_invoice_offset_uq').on(t.invoiceId, t.offsetDays),
    // The sweep's read: "which stages has this invoice already had?"
    index('invoice_reminders_account_invoice_idx').on(t.accountId, t.invoiceId),
  ],
);

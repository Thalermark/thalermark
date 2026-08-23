import { date, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts.js';
import { companies } from './companies.js';
import { contacts } from './contacts.js';

// A job is the unit of work the user names — "the Smith job", "Tuesdays at the
// Chens". It exists from the moment work starts, BEFORE anything is billed, and
// it emits zero or more invoices.
//
// Why it exists at all (TMC-181). Job costing shipped with the invoice standing
// in for the job, and that held only because every one of its inputs arrives
// AFTER the invoice: a receipt is entered later, so there is always an invoice
// to point at. Tracked time inverts it — the work happens first and the invoice
// is the OUTPUT of the hours, not a precondition for them, so at the moment a
// sitter starts at 6pm there is nothing to attach to. The draft invoice cannot
// stand in either: invoices.number is NOT NULL and assigned at create, so
// starting a job would burn a number on work that may never be billed, and
// finishing jobs out of order would desync numbering from issue order.
//
// OPT-IN AND ADDITIVE. An invoice MAY belong to a job and a cost MAY be tagged
// to one; nothing was backfilled and nothing that ignores jobs changes
// behaviour. The job-margin report gains job rows beside the invoice rows it
// already produced — for a company with no jobs its output is unchanged, which
// is the acceptance test for this whole model.
//
// Like expense_allocations, this posts NOTHING to the ledger and is referenced
// by no journal entry. Drop jobs and time_entries and the books, taxes and
// invoices are identical. A tag layer, not a route; a design that starts
// wanting journal entries to make job margin work is the wrong design.
//
// FLAT BY INTENT: no parent job, no sub-jobs. PROJECT.md has said "no project
// hierarchy" since the MVP lock and nothing since has argued for one.
export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    // What the user calls it. Free text, not derived from the contact: "the
    // Smith job" and "Tuesdays at the Chens" are both valid and only he knows
    // which one he means.
    name: text('name').notNull(),
    // SET NULL, unlike invoices.contact_id which is RESTRICT. An invoice
    // without a customer is meaningless; a job without one is merely
    // unlabelled, and losing the job record would be the worse outcome.
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    // 'open' | 'closed'. App-layer enum, CHECK deferred — same call as
    // items.type and companies.business_type. Closing is a filing action, not a
    // state machine: it hides the job from the pickers and nothing else.
    status: text('status').notNull().default('open'),
    // How this job bills, asked ONCE at the job rather than per entry (TMC-264).
    // 'hour' | 'visit' | 'day' | 'night' | 'job'. App-layer enum, CHECK deferred
    // — same call as status above and items.type.
    //
    // WHY THE JOB AND NOT THE ENTRY. The audience bills the same way every time:
    // a dog walker charges per visit on every visit, a sitter per night on every
    // night. Asking per entry would ask a question whose answer never changes,
    // and asking it on the invoice line would be too late — the hours are
    // already logged by then.
    //
    // 'hour' is the default and reproduces exactly the old behaviour: quantity
    // derives from minutes, which is what every pre-TMC-264 entry did and what
    // every existing job keeps doing untouched.
    //
    // A CLOSED SET, not free text, and that is a real limitation worth naming:
    // a lawn crew pricing per yard cannot say "yard" here. The set is closed
    // because these five have known plurals and the invoice line has to read
    // "3 visits" rather than "3 visitss" — the same reason hoursUnitLabel exists
    // and the same trap items.unit_label's comment describes. The seeded line's
    // unitLabel stays editable on both clients, so a per-yard business can still
    // correct it on the invoice; widening this set is a data change, not a
    // schema one, whenever someone asks.
    billingUnit: text('billing_unit').notNull().default('hour'),
    // Both nullable. The user may never bother, and a job with no dates is
    // still a perfectly good container.
    startedOn: date('started_on', { mode: 'string' }),
    endedOn: date('ended_on', { mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountIdIdx: index('jobs_account_id_idx').on(table.accountId),
    // Backs the open-jobs picker on the time-entry and expense-tagging forms,
    // which is the hottest read: always one company, almost always status open.
    companyStatusIdx: index('jobs_company_status_idx').on(
      table.accountId,
      table.companyId,
      table.status,
    ),
    // Backs the keyset list: WHERE account_id ORDER BY name ASC, id ASC — the
    // same shape as items_account_name_idx.
    accountNameIdx: index('jobs_account_name_idx').on(table.accountId, table.name, table.id),
    contactIdIdx: index('jobs_contact_id_idx').on(table.accountId, table.contactId),
  }),
);

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;

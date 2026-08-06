import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts.js';
import { authUser } from './auth.js';
import { companies } from './companies.js';
import { jobs } from './jobs.js';

// A running stopwatch (TMC-180). One row exists only while a timer runs; stopping
// deletes it and hands the elapsed minutes to the log form.
//
// PER JOB, but ONE AT A TIME PER PERSON. Both halves matter:
//
//   - per job, because you start a timer while looking at the job you are
//     standing in front of. job_id is the thing being timed.
//   - one at a time, because nobody works two jobs at once. The unique index on
//     (account_id, user_id) makes a second concurrent timer impossible rather
//     than merely discouraged.
//
// Starting a second timer is REFUSED, naming the one already running, rather
// than auto-stopping it. Auto-stopping sounds kinder and is worse: the classic
// failure is forgetting to stop at house 1, driving 25 minutes, and starting at
// house 2 — auto-stop would silently log house 1 with the drive inside it.
// Refusing forces the correction at the one moment the duration can still be
// fixed by the person who knows what actually happened.
//
// Nothing here is time DATA — it is UI state that happens to need to outlive a
// device. The record of work is time_entries; a timer that is never stopped has
// recorded nothing, which is the honest outcome for work nobody logged.
export const timeTimers = pgTable(
  'time_timers',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    // Whose timer. Scoped to the auth user rather than the membership so a timer
    // survives a role change, and so the "one at a time" rule follows the person.
    userId: uuid('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    // Elapsed time is always computed from this, never accumulated — so a closed
    // laptop, a dead phone or a clock the client disagrees with cannot drift it.
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    // Carried through the stop so a note typed at the start is not lost.
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountIdIdx: index('time_timers_account_id_idx').on(table.accountId),
    // The rule, enforced by the database: one running timer per person.
    userUq: uniqueIndex('time_timers_user_uq').on(table.accountId, table.userId),
    jobIdIdx: index('time_timers_job_id_idx').on(table.accountId, table.jobId),
  }),
);

export type TimeTimer = typeof timeTimers.$inferSelect;
export type NewTimeTimer = typeof timeTimers.$inferInsert;

import { boolean, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  // Per-account opt-in for the telemetry stream documented in TELEMETRY.md.
  // Default false: no events are collected until the account explicitly opts in.
  telemetryEnabled: boolean('telemetry_enabled').notNull().default(false),
  // Anonymous label for this account in the telemetry stream. Generated when
  // opt-in flips on; never reversible to the account row without DB access.
  // Null = opted-out (which is also the default).
  telemetryInstallId: uuid('telemetry_install_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;

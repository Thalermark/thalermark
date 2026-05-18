import { bigint, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts.js';

// Local staging table for the telemetry stream. Writes are gated by
// accounts.telemetry_enabled at the app layer; RLS scopes reads and writes
// to the request's account_id (see the RLS migration). Rows are deleted by
// the HTTP transport once batched send succeeds (Slice 2.4).
//
// `payload` is opaque jsonb here — the typed Event union lives in
// @thalermark/telemetry and is serialized into this column by emit().
// Keeping the column untyped avoids a db -> telemetry dependency.
//
// retry_count / last_attempt_at track transport state for rows that have
// failed delivery with a retryable error. The flush loop selects rows where
// retry_count < cap, and drops (with a log line) on cap exceeded. 4xx drops
// immediately; 5xx and network errors increment and retry.
export const telemetryEvents = pgTable('telemetry_events', {
  id: uuid('id').primaryKey(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id),
  eventName: text('event_name').notNull(),
  payload: jsonb('payload').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  retryCount: bigint('retry_count', { mode: 'number' }).notNull().default(0),
  lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
});

export type TelemetryEvent = typeof telemetryEvents.$inferSelect;
export type NewTelemetryEvent = typeof telemetryEvents.$inferInsert;

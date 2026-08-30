import { bigint, boolean, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts.js';
import { authUser } from './auth.js';

// The account's LLM connection — the DB-backed replacement for the LLM_* env
// block. One row per account, written from Settings → AI (or the seed CLI).
//
// A row exists ONLY when someone configured AI: the provider defaults (labels,
// adapters, per-role model ids) live in code as `PRESETS` in @thalermark/ai, so
// an empty table is the correct zero-config state and self-host needs no
// seeding. Same shape as the email_templates override pattern. Model ids churn
// fast; keeping them in code means they update with the image instead of going
// stale in a seed row.
//
// Columns mirror `LlmCredential` 1:1 so the store maps to it with no transform:
// `provider` names a PRESET (never an adapter — the adapter is a property of
// the preset, looked up in code, so it is deliberately not a column here).
// `base_url` / the three model columns override the preset when set. NULL means
// "use the preset's value", which is also why `structured` is a nullable bool
// rather than NOT NULL DEFAULT false: null = trust the preset, and the
// save-time probe writes the real answer for `custom` endpoints.
//
// `api_key_ciphertext` is AES-256-GCM, `v1:iv:tag:ciphertext` (see
// apps/api/src/lib/crypto.ts). It is NULL for Ollama, which needs no key. The
// plaintext key is never stored, never logged, and never returned to a client.
//
// Health, not "verified once": keys get revoked and quotas run out, so the real
// AI calls write these three columns alongside the save-time probe. A
// connection is only usable once `last_ok_at IS NOT NULL` — so a broken save
// can never take AI live — and once it has succeeded it owns the account
// (later failures surface as errors rather than silently falling back).
export const llmConnections = pgTable(
  'llm_connections',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    baseUrl: text('base_url'),
    apiKeyCiphertext: text('api_key_ciphertext'),
    modelVision: text('model_vision'),
    modelReasoning: text('model_reasoning'),
    modelFast: text('model_fast'),
    structured: boolean('structured'),
    // Per-connection ceiling for every AI call, in seconds (TMC-296 follow-up).
    // NULL means the per-purpose defaults in @thalermark/ai/limits apply; set,
    // it replaces them all — the knob exists for slow self-host hardware (a
    // CPU-only Ollama can need minutes where a hosted API needs seconds).
    // Bounds (30–300) are enforced by the validation schema, not a CHECK: the
    // ceiling tracks what the HTTP stack tolerates, which is a code fact.
    // bigint like every other counter here (the squawk rule, not the range).
    timeoutSeconds: bigint('timeout_seconds', { mode: 'number' }),
    lastOkAt: timestamp('last_ok_at', { withTimezone: true }),
    lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
    lastError: text('last_error'),
    // Who last pointed this workspace at a provider. The seed CLI writes the
    // synthetic system user (auth_user.is_system), the same actor the recurring
    // -invoice job and Stripe webhooks use, so this stays NOT NULL.
    updatedBy: uuid('updated_by')
      .notNull()
      .references(() => authUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // One connection per account. Also serves every read: the resolver looks up
    // by account_id on each AI call, and the RLS policy filters on it.
    accountUq: uniqueIndex('llm_connections_account_uq').on(table.accountId),
  }),
);

export type LlmConnection = typeof llmConnections.$inferSelect;
export type NewLlmConnection = typeof llmConnections.$inferInsert;

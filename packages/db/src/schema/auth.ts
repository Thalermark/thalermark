import {
  bigint,
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { accounts } from './accounts.js';

// Seeded by migration 0009. The synthetic actor for system-initiated audit
// events; has no auth_account row, so cannot sign in.
export const SYSTEM_USER_ID = '00000000-0000-7000-8000-000000000001';

// auth_user — Better Auth's user table (a person with a login)
export const authUser = pgTable('auth_user', {
  id: uuid('id').primaryKey(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  name: text('name'),
  image: text('image'),
  // Thalermark internal employee (NOT a member of the customer's account).
  // Read-only impersonation of any account for support; enforced via a separate
  // BYPASSRLS Postgres role at the API connection-pool layer.
  isStaff: boolean('is_staff').notNull().default(false),
  // Synthetic actor for system-initiated mutations (recurring invoice jobs,
  // Stripe webhooks). Has no auth_account row, so cannot sign in. Filter by
  // `is_system = false` in any "people in your account" query.
  isSystem: boolean('is_system').notNull().default(false),
  // Cross-device "last active account" anchor for the account picker. Null
  // until the user picks one; cleared (SET NULL) if the account is deleted.
  lastAccountId: uuid('last_account_id').references(() => accounts.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// auth_session — Better Auth's session table (active login sessions)
export const authSession = pgTable(
  'auth_session',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdIdx: index('auth_session_user_id_idx').on(table.userId),
    expiresAtIdx: index('auth_session_expires_at_idx').on(table.expiresAt),
  }),
);

// auth_account — Better Auth's account-linkage table.
// One row per (user, auth provider) pair. The "credentials" provider stores
// the hashed password in the `password` column for email+password sign-in.
// Note: this is INTERNAL to Better Auth and unrelated to our domain `accounts` table.
export const authAccount = pgTable(
  'auth_account',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    providerId: text('provider_id').notNull(),
    accountId: text('account_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    providerAccountIdx: uniqueIndex('auth_account_provider_account_idx').on(
      table.providerId,
      table.accountId,
    ),
  }),
);

// auth_verification — Better Auth's short-lived token table
// (email verification, password reset, magic links).
export const authVerification = pgTable(
  'auth_verification',
  {
    id: uuid('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    identifierIdx: index('auth_verification_identifier_idx').on(table.identifier),
  }),
);

// auth_rate_limit — Better Auth's request rate-limit counters (storage:'database').
// One row per limiter key (BA keys by IP + path); `count` is the hits in the
// current window, `last_request` an epoch-ms timestamp (hence bigint, not int4).
// No RLS — like the other auth_* tables this is owned by Better Auth on the
// bootstrap/superuser connection, never tenant-scoped. The api enables the
// limiter only in production (RATE_LIMIT_ENABLED); the table exists regardless.
export const authRateLimit = pgTable(
  'auth_rate_limit',
  {
    id: uuid('id').primaryKey(),
    key: text('key').notNull(),
    // bigint (not int4): a small counter in practice, but squawk's
    // prefer-bigint rule rejects int4, and it stays consistent with last_request.
    // BA reads/writes it as a plain JS number (mode:'number').
    count: bigint('count', { mode: 'number' }).notNull(),
    lastRequest: bigint('last_request', { mode: 'number' }).notNull(),
  },
  (table) => ({
    keyIdx: index('auth_rate_limit_key_idx').on(table.key),
  }),
);

// ─── OAuth / OIDC provider (open-core IdP seam) ──────────────────────────────
// Better Auth's oidc-provider + mcp plugin tables. Populated only when the
// per-account IdP seam is configured — a commercial deployment turns core into
// the OAuth/OIDC authority for its dashboard/admin surfaces and MCP clients (see
// @thalermark/auth CreateAuthOptions.idp). On self-host the plugin is never
// loaded, so these tables stay empty: the same dormant-but-present posture as
// auth_rate_limit. Owned by Better Auth on the app connection, no RLS — an OAuth
// client/token/consent is per-user (keyed by the BA user), NOT tenant data keyed
// by account_id, so the tenant-isolation policy model doesn't apply. Column JS
// names mirror BA's model field names exactly (camelCase); that's how the drizzle
// adapter maps model → table.

// oauth_application — a registered OAuth client: a first-party trusted client
// (dashboard, admin) or a dynamically-registered MCP client.
export const oauthApplication = pgTable(
  'oauth_application',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    icon: text('icon'),
    metadata: text('metadata'),
    clientId: text('client_id').notNull().unique(),
    clientSecret: text('client_secret'),
    redirectUrls: text('redirect_urls').notNull(),
    type: text('type').notNull(),
    disabled: boolean('disabled').default(false),
    userId: uuid('user_id').references(() => authUser.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdIdx: index('oauth_application_user_id_idx').on(table.userId),
  }),
);

// oauth_access_token — an issued access/refresh token pair, bound to a client
// and (usually) a user. clientId references oauth_application.client_id (the
// unique client identifier), not its surrogate id — that's the join BA uses.
export const oauthAccessToken = pgTable(
  'oauth_access_token',
  {
    id: uuid('id').primaryKey(),
    accessToken: text('access_token').notNull().unique(),
    refreshToken: text('refresh_token').notNull().unique(),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }).notNull(),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }).notNull(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthApplication.clientId, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => authUser.id, { onDelete: 'cascade' }),
    scopes: text('scopes').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    clientIdIdx: index('oauth_access_token_client_id_idx').on(table.clientId),
    userIdIdx: index('oauth_access_token_user_id_idx').on(table.userId),
  }),
);

// oauth_consent — records that a user granted a client a scope set, so the
// consent screen shows once rather than on every authorize.
export const oauthConsent = pgTable(
  'oauth_consent',
  {
    id: uuid('id').primaryKey(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthApplication.clientId, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    scopes: text('scopes').notNull(),
    consentGiven: boolean('consent_given').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    clientIdIdx: index('oauth_consent_client_id_idx').on(table.clientId),
    userIdIdx: index('oauth_consent_user_id_idx').on(table.userId),
  }),
);

export type AuthUser = typeof authUser.$inferSelect;
export type NewAuthUser = typeof authUser.$inferInsert;
export type AuthSession = typeof authSession.$inferSelect;
export type NewAuthSession = typeof authSession.$inferInsert;
export type AuthAccount = typeof authAccount.$inferSelect;
export type NewAuthAccount = typeof authAccount.$inferInsert;
export type AuthVerification = typeof authVerification.$inferSelect;
export type NewAuthVerification = typeof authVerification.$inferInsert;
export type AuthRateLimit = typeof authRateLimit.$inferSelect;
export type NewAuthRateLimit = typeof authRateLimit.$inferInsert;
export type OauthApplication = typeof oauthApplication.$inferSelect;
export type NewOauthApplication = typeof oauthApplication.$inferInsert;
export type OauthAccessToken = typeof oauthAccessToken.$inferSelect;
export type NewOauthAccessToken = typeof oauthAccessToken.$inferInsert;
export type OauthConsent = typeof oauthConsent.$inferSelect;
export type NewOauthConsent = typeof oauthConsent.$inferInsert;

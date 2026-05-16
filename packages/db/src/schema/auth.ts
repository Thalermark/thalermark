import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

// auth_user — Better Auth's user table (a person with a login)
export const authUser = pgTable('auth_user', {
  id: uuid('id').primaryKey(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  name: text('name'),
  image: text('image'),
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

export type AuthUser = typeof authUser.$inferSelect;
export type NewAuthUser = typeof authUser.$inferInsert;
export type AuthSession = typeof authSession.$inferSelect;
export type NewAuthSession = typeof authSession.$inferInsert;
export type AuthAccount = typeof authAccount.$inferSelect;
export type NewAuthAccount = typeof authAccount.$inferInsert;
export type AuthVerification = typeof authVerification.$inferSelect;
export type NewAuthVerification = typeof authVerification.$inferInsert;

import type { Database } from '@thalermark/db';
import { authAccount, authSession, authUser, authVerification } from '@thalermark/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { v7 as uuidv7 } from 'uuid';

export type CreateAuthOptions = {
  secret: string;
  baseURL: string;
  trustedOrigins?: string[];
};

// Wires Better Auth to our auth_* Drizzle tables. Email/password ON; the
// orgs plugin is intentionally OFF (multi-tenancy is Thalermark's domain
// — accounts/companies/memberships — not BA's). uuidv7 generateId keeps
// auth row IDs aligned with the project-wide ID convention.
export function createAuth(db: Database, options: CreateAuthOptions) {
  return betterAuth({
    secret: options.secret,
    baseURL: options.baseURL,
    trustedOrigins: options.trustedOrigins,
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: {
        user: authUser,
        session: authSession,
        account: authAccount,
        verification: authVerification,
      },
    }),
    emailAndPassword: {
      enabled: true,
    },
    advanced: {
      database: {
        generateId: () => uuidv7(),
      },
    },
  });
}

export type AuthInstance = ReturnType<typeof createAuth>;

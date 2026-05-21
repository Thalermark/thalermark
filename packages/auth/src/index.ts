import type { Database } from '@thalermark/db';
import {
  accounts,
  authAccount,
  authSession,
  authUser,
  authVerification,
  memberships,
} from '@thalermark/db';
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
//
// On sign-up the user.create.after hook seeds a fresh `accounts` row + a
// matching `memberships` row in one transaction. Without this every new user
// would land on the 0-membership "sign-up-incomplete" screen because the
// authed-shell middleware requires ≥1 membership. Accept-invite is the other
// path to a membership and runs outside this hook.
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
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            const accountName = user.name?.trim() || user.email.split('@')[0] || 'My account';
            await db.transaction(async (tx) => {
              const accountId = uuidv7();
              await tx.insert(accounts).values({ id: accountId, name: accountName });
              await tx.insert(memberships).values({
                id: uuidv7(),
                userId: user.id,
                accountId,
              });
            });
          },
        },
      },
    },
    advanced: {
      database: {
        generateId: () => uuidv7(),
      },
    },
  });
}

export type AuthInstance = ReturnType<typeof createAuth>;

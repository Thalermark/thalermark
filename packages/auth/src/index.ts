import type { Database } from '@thalermark/db';
import {
  accounts,
  authAccount,
  authSession,
  authUser,
  authVerification,
  companies,
  memberships,
  seedChartOfAccounts,
} from '@thalermark/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer } from 'better-auth/plugins';
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
// On sign-up the user.create.after hook seeds an `accounts` row + a default
// `companies` row + a `memberships` row in one transaction. Without the
// account+membership every new user would land on the 0-membership
// "sign-up-incomplete" screen (authed-shell middleware requires ≥1
// membership). The default company keeps the invoice/customer flows usable
// from minute one for the overwhelming single-company case; explicit
// company management (rename, add side hustle) lands with that UI slice.
// Accept-invite is the other path to a membership and runs outside this hook.
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
    // Mobile uses Authorization: Bearer <session-token> instead of cookies.
    // The bearer plugin is a no-op for cookie clients (web): its `before` hook
    // only converts a bearer header into a session cookie if one is present.
    // On responses it sets `set-auth-token` whenever a session cookie is being
    // set, so mobile clients can grab the token and persist it themselves.
    plugins: [bearer()],
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            const accountName = user.name?.trim() || user.email.split('@')[0] || 'My account';
            await db.transaction(async (tx) => {
              const accountId = uuidv7();
              const companyId = uuidv7();
              await tx.insert(accounts).values({ id: accountId, name: accountName });
              await tx.insert(companies).values({
                id: companyId,
                accountId,
                name: accountName,
              });
              await tx.insert(memberships).values({
                id: uuidv7(),
                userId: user.id,
                accountId,
              });
              // Seed the sole-prop chart of accounts into the default
              // company so the ledger (per [[project_ledger_decision]])
              // has somewhere to post from the first mark-sent. Business
              // type stays null until the L3 wizard surfaces the picker;
              // the seeder maps null → sole-prop today.
              await seedChartOfAccounts(tx, { accountId, companyId });
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

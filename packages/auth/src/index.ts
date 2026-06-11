import type { Database } from '@thalermark/db';
import {
  accounts,
  authAccount,
  authSession,
  authUser,
  authVerification,
  companies,
  invitations,
  memberships,
  seedChartOfAccounts,
} from '@thalermark/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer } from 'better-auth/plugins';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
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
// On sign-up the user.create.after hook gives the new user a membership in one
// transaction. Two paths:
//   - Invited signup (a pending, unexpired invite matches the email): JOIN the
//     inviting account(s) and seed NO personal company — an invited user is an
//     employee/contractor of the inviter, not a new business. They can create
//     their own company later via the (future) multi-company UI if they want.
//   - Fresh solo signup (no invite): seed an `accounts` row + a default
//     `companies` row + a `memberships` row + the sole-prop chart of accounts,
//     so the invoice/customer flows work from minute one. (Without ≥1 membership
//     the user lands on the 0-membership "sign-up-incomplete" screen.)
// Existing users (who already have an account) accept invites via the
// accept-invite endpoint, outside this hook.
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
            await db.transaction(async (tx) => {
              // Invited signup: join the inviting account(s), no personal
              // company. Match pending, unexpired invites by email (the invite's
              // trust anchor; the sign-up form locks the email to the invited
              // address). Multiple invites → join each. Mark them accepted so
              // they don't linger as pending on the inviter's team page.
              const pending = await tx
                .select({ id: invitations.id, accountId: invitations.accountId })
                .from(invitations)
                .where(
                  and(
                    sql`lower(${invitations.email}) = lower(${user.email})`,
                    isNull(invitations.acceptedAt),
                    gt(invitations.expiresAt, new Date()),
                  ),
                );

              if (pending.length > 0) {
                const now = new Date();
                for (const inv of pending) {
                  await tx
                    .insert(memberships)
                    .values({ id: uuidv7(), userId: user.id, accountId: inv.accountId })
                    .onConflictDoNothing({ target: [memberships.userId, memberships.accountId] });
                  await tx
                    .update(invitations)
                    .set({ acceptedAt: now, acceptedByUserId: user.id, updatedAt: now })
                    .where(eq(invitations.id, inv.id));
                }
                return;
              }

              // Fresh solo signup — seed a personal account + default company +
              // membership + sole-prop COA (the ledger needs somewhere to post
              // from the first mark-sent; business type stays null → sole-prop).
              const accountName = user.name?.trim() || user.email.split('@')[0] || 'My account';
              const accountId = uuidv7();
              const companyId = uuidv7();
              await tx.insert(accounts).values({ id: accountId, name: accountName });
              await tx.insert(companies).values({ id: companyId, accountId, name: accountName });
              // The creator of a personal account is its owner (protected: can't
              // be removed or leave). Invited members above join as the default
              // 'member' role.
              await tx
                .insert(memberships)
                .values({ id: uuidv7(), userId: user.id, accountId, role: 'owner' });
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

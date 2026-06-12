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

// clientId/clientSecret pair for an OAuth provider. Google, Facebook, and X
// (Better Auth provider key `twitter`) all share this shape.
export type SocialProviderCreds = { clientId: string; clientSecret: string };

export type CreateAuthOptions = {
  secret: string;
  baseURL: string;
  trustedOrigins?: string[];
  // Optional social sign-in. Each provider is wired only when its creds are
  // passed, so a self-host install with none runs unchanged (email/password
  // only). Adding another provider later is the same three lines below. Each
  // provider's OAuth callback lands at `${baseURL}/api/auth/callback/<provider>`
  // (`google` / `facebook` / `twitter`) — that exact URL must be registered as
  // an authorized redirect URI on the provider's OAuth app.
  google?: SocialProviderCreds;
  facebook?: SocialProviderCreds;
  twitter?: SocialProviderCreds; // X
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
    // Social sign-in is opt-in per provider: each key is present only when its
    // creds were passed. A new social user flows through the same
    // user.create.after hook below (tenant provisioning or invite-by-email join)
    // as an email/password signup — the provider supplies a verified name +
    // email, so nothing about provisioning changes. (Facebook/X apps must be
    // configured to return the user's email for the join-by-email to work.)
    socialProviders: {
      ...(options.google ? { google: options.google } : {}),
      ...(options.facebook ? { facebook: options.facebook } : {}),
      ...(options.twitter ? { twitter: options.twitter } : {}),
    },
    account: {
      // Make "Continue with Google" attach to an existing same-email account
      // (created via email/password, or an invite) instead of erroring with
      // `account_not_linked`. Two BA guards must both pass:
      //   • trustedProviders — we trust these providers' verified email, so the
      //     provider side of the match is allowed.
      //   • requireLocalEmailVerified — BA defaults this to TRUE and refuses to
      //     link to an unverified LOCAL account. Our email/password signups
      //     aren't email-verified yet, so without setting it false, linking
      //     still throws for every existing account. We set it false.
      // Linking attaches to the existing user row (no new user → the
      // provisioning hook doesn't re-fire); emails must match (allowDifferentEmails
      // stays at its safe default, false).
      //
      // ⚠️ requireLocalEmailVerified=false is the explicit acceptance of the
      // pre-account-hijack risk (a squatted unverified email could be linked on
      // first social login). The fix is email verification on signup — once
      // signups are verified, REMOVE this line (BA's safe default returns and
      // linking still works, because the local account is then verified). See
      // the project_social_auth memory follow-up.
      accountLinking: {
        enabled: true,
        trustedProviders: ['google', 'facebook', 'twitter'],
        requireLocalEmailVerified: false,
      },
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
                .select({
                  id: invitations.id,
                  accountId: invitations.accountId,
                  role: invitations.role,
                })
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
                    .values({
                      id: uuidv7(),
                      userId: user.id,
                      accountId: inv.accountId,
                      role: inv.role,
                    })
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

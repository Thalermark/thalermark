import { expo } from '@better-auth/expo';
import type { Database } from '@thalermark/db';
import {
  accounts,
  authAccount,
  authRateLimit,
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
import { APIError } from 'better-auth/api';
import { bearer } from 'better-auth/plugins';
import disposableDomains from 'disposable-email-domains';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

// Disposable / temporary-email domains (10-minute-mail etc.) blocked at signup
// for abuse prevention. Built once from the bundled `disposable-email-domains`
// list (a vendored array — no external service, self-host-safe).
const DISPOSABLE_DOMAINS = new Set(disposableDomains.map((d) => d.toLowerCase()));

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
  // Require email/password users to verify their address before they can sign
  // in. Off by default (and in tests, so the suite's sign-up→use-session flow
  // keeps working); the api turns it on outside the test env. Social signups
  // are provider-verified, so they're never gated.
  requireEmailVerification?: boolean;
  // Sends the verification email. Injected by the api (mailer-agnostic here);
  // a no-op when absent. Called by Better Auth with the one-time verify URL.
  sendVerificationEmail?: (data: {
    user: { email: string; name?: string | null };
    url: string;
  }) => Promise<void>;
  // Sends the password-reset email. Injected by the api (mailer-agnostic here);
  // when absent, the reset endpoint is disabled — a self-host install without a
  // mailer simply has no reset path, same posture as verification above. Better
  // Auth hands us the one-time `token`; the api builds the link to the web app's
  // /reset-password page from publicAppUrl (server controls the target, so it
  // works cross-device and needs no client redirectTo).
  sendResetPassword?: (data: {
    user: { email: string; name?: string | null };
    token: string;
  }) => Promise<void>;
  // Turn on Better Auth's built-in request rate limiting. Off by default (and in
  // dev/test, so the integration suite isn't throttled); the api enables it in
  // production. Counters live in the auth_rate_limit table (storage:'database')
  // so they survive restarts with no second datastore. The per-path ceilings are
  // fixed in the rateLimit config below — this flag only gates the whole thing.
  rateLimitEnabled?: boolean;
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
        rateLimit: authRateLimit,
      },
    }),
    // Brute-force / password-spray backoff. Enabled only in production (the api
    // gates it); when off, Better Auth skips the limiter entirely. The baseline
    // (BA's default ~100 req / 10s per IP+path) is generous enough for normal
    // auth traffic — get-session polls, social callbacks — while customRules
    // clamp the credential-guessing endpoints hard. Keying is per IP + path, so
    // a cooldown never locks a *named* user out (anti-DoS): the bare email is
    // never part of the key, and password reset is the escape hatch. Counters
    // persist in auth_rate_limit (storage:'database').
    rateLimit: {
      enabled: options.rateLimitEnabled ?? false,
      storage: 'database',
      customRules: {
        '/sign-in/email': { window: 60, max: 10 },
        '/sign-up/email': { window: 60, max: 10 },
        '/request-password-reset': { window: 3600, max: 5 },
        '/reset-password': { window: 3600, max: 10 },
      },
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: options.requireEmailVerification ?? false,
      // Password reset is wired only when a sender is injected (mailer present).
      // Better Auth disables the /request-password-reset endpoint when this is
      // absent, so a no-mailer self-host install has no half-built reset path.
      // BA passes the one-time `token`; the api turns it into the web app link.
      sendResetPassword: options.sendResetPassword
        ? async ({ user, token }) => {
            await options.sendResetPassword?.({ user, token });
          }
        : undefined,
      // A completed reset kills every existing session for that user — if the
      // reset was a recovery from a compromised password, the attacker's
      // sessions die with it.
      revokeSessionsOnPasswordReset: true,
    },
    emailVerification: {
      // Send the verification link automatically on signup (only meaningful when
      // verification is required). autoSignInAfterVerification creates the
      // session when they click the link, so they land straight in the app.
      sendOnSignUp: options.requireEmailVerification ?? false,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        await options.sendVerificationEmail?.({ user, url });
      },
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
      // "Continue with Google" attaches to an existing same-email account
      // instead of erroring `account_not_linked`. trustedProviders clears the
      // provider side; the local side relies on BA's default
      // requireLocalEmailVerified (true) — now safe to keep, because
      // requireEmailVerification above means existing local accounts are
      // verified, so the link goes through. Linking attaches to the existing
      // user row (no new user → the provisioning hook doesn't re-fire); emails
      // must match (allowDifferentEmails stays false).
      accountLinking: {
        enabled: true,
        trustedProviders: ['google', 'facebook', 'twitter'],
      },
    },
    // Mobile uses Authorization: Bearer <session-token> instead of cookies.
    // The bearer plugin is a no-op for cookie clients (web): its `before` hook
    // only converts a bearer header into a session cookie if one is present.
    // On responses it sets `set-auth-token` whenever a session cookie is being
    // set, so mobile clients can grab the token and persist it themselves.
    //
    // The expo plugin lets the native app complete OAuth social sign-in: it
    // trusts the app scheme as an origin and rewrites the social callback to a
    // deep link so the system-browser flow can return to the app (web is
    // unaffected — it keeps using http callbacks). Pairs with `expoClient` on
    // apps/mobile.
    plugins: [bearer(), expo()],
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            // Block disposable / temporary email at signup (abuse prevention).
            // Applies to every user creation; a real provider email is never on
            // the list. Throw an APIError so the client gets a clean message.
            const domain = user.email.split('@')[1]?.toLowerCase();
            if (domain && DISPOSABLE_DOMAINS.has(domain)) {
              throw new APIError('UNPROCESSABLE_ENTITY', {
                message: 'Please use a non-disposable email address.',
              });
            }
            // Auto-verify invited signups: receiving the invite link already
            // proves the person controls that email, so we don't gate them
            // behind a second verification email. (The membership join itself
            // stays in the after-hook.) Read via the same bootstrap `db` the
            // after-hook uses — no tenant context needed for this lookup.
            const invited = await db
              .select({ id: invitations.id })
              .from(invitations)
              .where(
                and(
                  sql`lower(${invitations.email}) = lower(${user.email})`,
                  isNull(invitations.acceptedAt),
                  gt(invitations.expiresAt, new Date()),
                ),
              )
              .limit(1);
            if (invited.length > 0) {
              return { data: { ...user, emailVerified: true } };
            }
            return undefined;
          },
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

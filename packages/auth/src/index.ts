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
  oauthAccessToken,
  oauthApplication,
  oauthConsent,
  seedChartOfAccounts,
} from '@thalermark/db';
import { checkPassword } from '@thalermark/validation';
import { type BetterAuthPlugin, betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { bearer, mcp } from 'better-auth/plugins';
import disposableDomains from 'disposable-email-domains' with { type: 'json' };
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

// Disposable / temporary-email domains (10-minute-mail etc.) blocked at signup
// for abuse prevention. Built once from the bundled `disposable-email-domains`
// list (a vendored array — no external service, self-host-safe).
const DISPOSABLE_DOMAINS = new Set(disposableDomains.map((d) => d.toLowerCase()));

// Better Auth endpoints that establish or change a password, and the request
// body field each one carries the new secret under. The password policy gate
// (hooks.before) runs on all of them, so the strength / common-password check
// holds at "establish AND change" — what NIST 800-63B requires — not just at
// signup. /change-password + /set-password aren't surfaced in our UI yet, but
// Better Auth exposes the endpoints, so gating them is defense in depth.
const PASSWORD_BODY_FIELD: Record<string, string> = {
  '/sign-up/email': 'password',
  '/reset-password': 'newPassword',
  '/change-password': 'newPassword',
  '/set-password': 'newPassword',
};

// clientId/clientSecret pair for an OAuth provider. Google, Facebook, and X
// (Better Auth provider key `twitter`) all share this shape.
export type SocialProviderCreds = { clientId: string; clientSecret: string };

// The open-core identity-provider seam. When present, core turns on Better Auth's
// `mcp` plugin (which wraps `oidc-provider`), becoming the OAuth2/OIDC authority
// for the commercial dashboard/admin surfaces AND MCP clients. Absent (self-host,
// tests) → the plugin doesn't load and the auth graph is byte-identical to today.
// The whole config is INJECTED by the composition root — client secrets are
// commercial-only, never hardcoded in core.
//
// Client model (traced from better-auth@1.6.13, not assumed): `mcp()` mounts only
// `/api/auth/mcp/{authorize,token,register}` and resolves EVERY client from the
// `oauth_application` table — it does not read any config-level trusted-client
// list (the endpoint that would, `/oauth2/authorize`, is never mounted). So
// first-party clients (dashboard/admin) are ROWS a deployment seeds into
// `oauth_application`, not seam config. Consent is prompt-driven: no
// `prompt=consent` → a silent code for any registered client; `prompt=consent` →
// redirect to `consentPage`. And `/mcp/register` (RFC 7591) is ALWAYS open and
// anonymous when the seam is on — there is no seam-level off-switch for dynamic
// registration today (the `mcp()` register handler never checks one).
export type IdpOptions = {
  // Where Better Auth sends an unauthenticated user to sign in — the web app's
  // existing login page (e.g. `${publicAppUrl}/login`). No new login UI.
  loginPage: string;
  // A dashboard-hosted consent page for MCP clients that request `prompt=consent`.
  // Core redirects to it with `?consent_code&client_id&scope`; the page POSTs the
  // decision back to `/api/auth/oauth2/consent`. Omitted → no consent screen (every
  // registered client gets a silent code).
  consentPage?: string;
  // The MCP protected-resource identifier advertised in discovery metadata (the
  // MCP server's URL). Optional — set by a deployment that runs an MCP server.
  resource?: string;
  // Custom OAuth scopes this authority issues, ON TOP of the OIDC defaults the
  // mcp plugin always adds (openid/profile/email/offline_access). One per tool
  // family the MCP layer gates on (e.g. contacts:write). Undefined → only the
  // defaults, so self-host/tests are unchanged. Forwarded verbatim to the mcp
  // plugin's oidcConfig.scopes.
  scopes?: string[];
};

// The transaction the signup provisioning runs in — the same `tx` that inserts
// the account/company/membership/COA rows. A commercial onAccountCreated hook
// runs on it so its per-account provisioning commits (or rolls back) atomically
// with the account itself.
type SignupTx = Parameters<Parameters<Database['transaction']>[0]>[0];

// Handed to onAccountCreated when a brand-new tenant account is provisioned.
// Deliberately minimal — mirrors the EntitlementProvider / LlmCredentialResolver
// seams, which pass just the account id and let the provider look up the rest:
// the freshly created account's id, its owner (the signing-up user's id), and the
// live signup transaction to write within.
export type AccountCreatedContext = {
  accountId: string;
  ownerUserId: string;
  tx: SignupTx;
};

// Handed to onSessionRevoked when a Better Auth session row is deleted — the
// user signed out, or a session was revoked (revoke-session/-sessions,
// password-reset revocation, account deletion). All of those route through BA's
// session delete hook. Deliberately minimal, like AccountCreatedContext: just
// the identifiers a consumer needs to end this user's sessions elsewhere.
// `userId` is the OIDC `sub` that sibling clients (dashboard/admin) key their
// own local sessions on; `sessionId` is the ended core session's id.
export type SessionRevokedContext = {
  userId: string;
  sessionId: string;
};

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
  // Open-core account-lifecycle door (SAAS-AND-PRODUCTION.md §8.3, door #3).
  // Fired inside the signup transaction the moment a NEW tenant account is
  // provisioned — fresh solo signup only; an invited user joins an EXISTING
  // account and never fires this. Self-host leaves it unset (a no-op: there are
  // no plans to provision), so the public build is byte-identical. The commercial
  // composition root injects a hook that writes the account's initial
  // subscription/trial row. It runs on the SAME transaction as the
  // account/company/membership/COA inserts, so provisioning is atomic: if the
  // hook throws, the whole signup rolls back and no half-provisioned tenant is
  // left behind.
  onAccountCreated?: (ctx: AccountCreatedContext) => Promise<void>;
  // Open-core single-logout seam (TMCLD-98). Fired best-effort AFTER a session
  // row is deleted — sign-out and every revoke path route through Better Auth's
  // session delete hook. Self-host leaves it unset (a no-op: there are no
  // sibling apps to notify), so the public build is byte-identical. The
  // commercial composition root injects a hook that signs + fans a logout
  // notification out to its OIDC client apps (dashboard/admin), which then end
  // their own local sessions — core stays free of the client registry and the
  // transport. A throw is swallowed (best-effort) so it can never break the
  // sign-out that triggered it; the injected hook owns its own delivery, retry,
  // and error reporting.
  onSessionRevoked?: (ctx: SessionRevokedContext) => Promise<void>;
  // Open-core identity-provider seam (single-login for dashboard/admin + MCP).
  // Present → the `mcp`/`oidc-provider` plugins are wired and core acts as the
  // OAuth2/OIDC authority. Undefined (self-host, tests) → neither loads and the
  // auth graph is unchanged. See IdpOptions.
  idp?: IdpOptions;
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
        // The oidc-provider/mcp plugin models. The drizzle adapter needs an
        // explicit table for every model a loaded plugin declares, so map these
        // only when the IdP seam is on (the plugin is added below under the same
        // condition). Absent otherwise — nothing references them.
        ...(options.idp ? { oauthApplication, oauthAccessToken, oauthConsent } : {}),
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
      // Visible minimum length, enforced by Better Auth on every password-setting
      // path (sign-up, reset, change). Matches the signup strength gate below: no
      // password under ~10 chars can clear "Weak" anyway, so this is the legible
      // front door. The `hooks.before` gate adds the strength/common-password rule
      // on top, for sign-up specifically.
      minPasswordLength: 10,
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
    // The IdP seam (opt-in): `mcp` wraps `oidc-provider`, so this single plugin
    // turns core into the OAuth2/OIDC authority AND exposes the MCP OAuth flow.
    // Only added when `idp` is injected — self-host stays on [bearer, expo].
    // Clients are resolved from the `oauth_application` table (a deployment seeds
    // its own first-party dashboard/admin rows); consent is prompt-driven and
    // delegated to the injected `consentPage`. Core ships no consent UI of its own.
    plugins: [
      bearer(),
      expo(),
      ...(options.idp
        ? [
            // Cast to the bare BetterAuthPlugin: mcp()'s specific return type
            // references better-auth's INTERNAL `MCPOptions`, which isn't exported,
            // so it would leak into this package's emitted .d.ts (TS4058). Erasing
            // to the exported plugin type keeps the declaration nameable; the one
            // consumer that needs the plugin's api — the discovery route in
            // apps/api/src/app.ts — casts locally. Runtime is unaffected.
            mcp({
              loginPage: options.idp.loginPage,
              resource: options.idp.resource,
              oidcConfig: {
                // Redundant with the top-level loginPage (mcp merges that in last),
                // but oidcConfig is typed as OIDCOptions, which requires it.
                loginPage: options.idp.loginPage,
                consentPage: options.idp.consentPage,
                scopes: options.idp.scopes,
              },
            }) as BetterAuthPlugin,
          ]
        : []),
    ],
    // Enforce the password policy at the boundary, on every endpoint that
    // establishes or changes a password (NIST 800-63B requires the blocklist /
    // strength check at "establish AND change", not just signup — see
    // PASSWORD_BODY_FIELD for the covered paths). The web + mobile forms run the
    // same checkPassword for instant feedback, but that's only UX — this request
    // hook is the gate. Rejects short or "Weak" passwords (which includes every
    // common-password blocklist match) with a clean client-facing message.
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        const field = PASSWORD_BODY_FIELD[ctx.path];
        if (!field) return;
        const body = ctx.body as Record<string, unknown> | undefined;
        const value = body?.[field];
        const check = checkPassword(typeof value === 'string' ? value : '');
        if (!check.ok) {
          throw new APIError('UNPROCESSABLE_ENTITY', { message: check.message });
        }
      }),
    },
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
              // Open-core account-lifecycle door: let a commercial layer
              // provision its own per-account state (e.g. a trial subscription
              // row) in this same transaction. No-op on self-host (unset). Runs
              // last, so the account/company/membership/COA it may read all
              // exist; a throw here rolls the entire signup back.
              await options.onAccountCreated?.({ accountId, ownerUserId: user.id, tx });
            });
          },
        },
      },
      // Single-logout seam (TMCLD-98): notify the injected hook when a session
      // ends, so a commercial layer can end the same user's sessions on sibling
      // OIDC clients (dashboard/admin). Only registered when the seam is
      // injected, so self-host's database-hook graph is byte-identical. Better
      // Auth routes sign-out and every revoke path through this delete hook and
      // hands us the full (pre-delete) session row, so userId/id are present.
      // Best-effort: a failed notification must never break the sign-out that
      // triggered it, so we swallow — the injected hook owns delivery + errors.
      ...(options.onSessionRevoked
        ? {
            session: {
              delete: {
                after: async (session) => {
                  try {
                    await options.onSessionRevoked?.({
                      userId: session.userId,
                      sessionId: session.id,
                    });
                  } catch {
                    // best-effort notification; never fail the sign-out
                  }
                },
              },
            },
          }
        : {}),
    },
    advanced: {
      database: {
        generateId: () => uuidv7(),
      },
    },
  });
}

export type AuthInstance = ReturnType<typeof createAuth>;

// Re-exported so a composition root can mount the OAuth-authorization-server
// discovery route (/.well-known/oauth-authorization-server, probed by MCP
// clients) without taking a direct better-auth dependency — Better Auth stays
// encapsulated in this package. Builds the discovery handler from the auth
// instance; only meaningful when the `idp` seam is on (the mcp plugin is loaded).
export { oAuthDiscoveryMetadata } from 'better-auth/plugins';

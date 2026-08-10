import * as Sentry from '@sentry/node';
import {
  type AccountCreatedContext,
  type IdpOptions,
  type SessionRevokedContext,
  type SocialProviderCreds,
  createAuth,
} from '@thalermark/auth';
import type { Database } from '@thalermark/db';
import { getLogger } from '@thalermark/logger';
import type { Env } from '../env.js';
import { type Mailer, mailerDelivers } from './mailer.js';
import { resetPasswordEmail } from './reset-password-email.js';
import { verificationEmail } from './verification-email.js';

const log = getLogger(['api', 'auth']);

// Social provider creds resolved from env — a provider is included only when
// BOTH halves are set (a half-set pair is an operator mistake, not a partial
// enable). Shared by createApiAuth (to wire the providers) and
// enabledSocialProviders (to tell the web which buttons to render), so the two
// can never disagree.
function socialCreds(env: Env): {
  google?: SocialProviderCreds;
  facebook?: SocialProviderCreds;
  twitter?: SocialProviderCreds;
} {
  return {
    ...(env.googleClientId && env.googleClientSecret
      ? { google: { clientId: env.googleClientId, clientSecret: env.googleClientSecret } }
      : {}),
    ...(env.facebookClientId && env.facebookClientSecret
      ? { facebook: { clientId: env.facebookClientId, clientSecret: env.facebookClientSecret } }
      : {}),
    ...(env.twitterClientId && env.twitterClientSecret
      ? { twitter: { clientId: env.twitterClientId, clientSecret: env.twitterClientSecret } }
      : {}),
  };
}

// The configured provider ids ('google' | 'facebook' | 'twitter'), surfaced to
// the web sign-in UI via GET /api/social-providers so it renders exactly the
// buttons that will work.
export function enabledSocialProviders(env: Env): string[] {
  return Object.keys(socialCreds(env));
}

// Better Auth builds the verification link from baseURL (the API origin) and
// embeds a `callbackURL` it redirects to AFTER marking the address verified —
// defaulting to `/`, which resolves against the API origin. When web + API are
// separate origins (dev, or any split deploy) that redirect lands on the API,
// which has no UI → a 404 right after a *successful* verify. Resolve a relative
// callbackURL against the web app (publicAppUrl) so it lands on the app instead.
// An absolute callbackURL (e.g. a mobile deep link) is left untouched. In a
// single-origin prod deploy (Caddy) publicAppUrl == the API origin, so this is a
// no-op there. Mirrors how password reset already targets the web app.
// Exported for unit testing (verification is off in the integration env).
export function verifyUrlWithAppCallback(url: string, appUrl: string): string {
  try {
    const u = new URL(url);
    const cb = u.searchParams.get('callbackURL') ?? '/';
    if (cb.startsWith('/')) {
      u.searchParams.set('callbackURL', new URL(cb, appUrl).toString());
    }
    return u.toString();
  } catch {
    return url;
  }
}

// Thin wrapper around @thalermark/auth's createAuth: pulls config out of the
// loaded env. server.ts holds the resulting handle and passes it into the
// Hono factory.
//
// `hooks` is the injection bag for open-core auth seams the composition root
// wires at construction time (they must reach createAuth, which builds the Better
// Auth instance up front). The public root (server.ts) passes none, so signup and
// the auth graph are byte-identical to today:
//   - onAccountCreated — the account-lifecycle seam: a commercial root provisions
//     the account's initial subscription/trial row inside the signup transaction
//     (AccountCreatedContext, atomic-with-signup semantics).
//   - onSessionRevoked — the single-logout seam: fired when a session ends so a
//     commercial root can end the same user's sessions on sibling OIDC clients
//     (TMCLD-98). Threaded here for the same reason — it's a Better Auth session
//     hook, wired when the instance is built.
//   - idp — the identity-provider seam: a commercial root injects trusted clients
//     + a login/consent page to turn core into the OAuth2/OIDC + MCP authority.
// It's a bag (not bare positionals) so adding a seam later doesn't grow the list.
export function createApiAuth(
  db: Database,
  env: Env,
  mailer?: Mailer,
  hooks?: {
    onAccountCreated?: (ctx: AccountCreatedContext) => Promise<void>;
    onSessionRevoked?: (ctx: SessionRevokedContext) => Promise<void>;
    idp?: IdpOptions;
  },
) {
  // The mailer, but only if it actually delivers (TMC-239). Bound to a const
  // rather than testing `mailerDelivers(mailer)` at each use so TypeScript
  // narrows it inside the senders below. A type predicate would have been
  // tempting and wrong: its false branch would exclude `Mailer`, but a
  // logs-only driver IS a Mailer — it just doesn't deliver.
  const deliveringMailer = mailerDelivers(mailer) ? mailer : undefined;

  return createAuth(db, {
    secret: env.betterAuthSecret,
    baseURL: env.betterAuthUrl,
    // The verification callbackURL (below) is the web-app origin; BA only honors
    // a callbackURL whose origin it trusts. publicAppUrl is usually already here
    // via TRUSTED_ORIGINS (and is the same origin as baseURL in single-origin
    // prod), but fold it in so the redirect can't be silently rejected.
    trustedOrigins: env.publicAppUrl
      ? Array.from(new Set([...env.trustedOrigins, env.publicAppUrl]))
      : env.trustedOrigins,
    rateLimitEnabled: env.rateLimitEnabled,
    // Open-core seams (see the `hooks` param above). Undefined on self-host, so
    // signup runs exactly as it does with no hook and no IdP plugins load.
    onAccountCreated: hooks?.onAccountCreated,
    onSessionRevoked: hooks?.onSessionRevoked,
    idp: hooks?.idp,
    ...socialCreds(env),
    // Require email verification only when there's a real way to deliver the
    // email. REQUIRE_EMAIL_VERIFICATION overrides either way; always off in the
    // test env (the integration suite signs up then immediately uses the
    // session).
    //
    // Keyed on the MAILER, not on `!!env.resendApiKey`, and the difference is a
    // lockout (TMC-239). The env var says a key was configured; it says nothing
    // about whether that key works. A revoked, rotated, expired or
    // rate-limited key put a correctly-configured install into a state where
    // verification was REQUIRED and no verification mail could arrive: sign-up
    // succeeded, sign-in was refused EMAIL_NOT_VERIFIED, the resend threw and
    // was swallowed by Better Auth, and password reset — the way out — failed
    // the same way. No self-service recovery, and nothing anywhere said why.
    requireEmailVerification:
      env.nodeEnv !== 'test' && (env.requireEmailVerification ?? deliveringMailer !== undefined),
    // Gated on DELIVERY, not on a mailer merely existing (TMC-239). bootstrap
    // always wires one — the console driver is the fallback — so `mailer ? …`
    // was never false and this sender was always defined. Third instance of
    // that dead-guard shape after the reminder sweep in TMC-212.
    sendVerificationEmail: deliveringMailer
      ? async ({ user, url }) => {
          if (!env.publicAppUrl) {
            log.warn(
              'PUBLIC_APP_URL is unset; the email-verification link will redirect to the API origin',
            );
          }
          // Land the post-verify redirect on the web app, not the API origin.
          const link = env.publicAppUrl ? verifyUrlWithAppCallback(url, env.publicAppUrl) : url;
          const { subject, html, text } = verificationEmail({ name: user.name, url: link });
          await reportingSendFailures('verification', user.email, () =>
            deliveringMailer.send({ to: user.email, subject, html, text }),
          );
        }
      : undefined,
    // Password-reset email through the same mailer. Better Auth gives us the
    // one-time token; we build the link to the web app's /reset-password page
    // from publicAppUrl so the server (not the client) owns the target — the
    // same link works whether the reset was requested from web or mobile, and
    // whatever device opens the email lands on the universal web page. Disabled
    // (BA returns RESET_PASSWORD_DISABLED) when no mailer is configured.
    // Same gate, same reason. With it, an install that cannot deliver returns
    // Better Auth's RESET_PASSWORD_DISABLED to the caller — which is what makes
    // the honest copy on /forgot-password possible at all — and BA throws
    // before minting a token, so no live reset link is written to the log.
    sendResetPassword: deliveringMailer
      ? async ({ user, token }) => {
          if (!env.publicAppUrl) {
            log.warn('PUBLIC_APP_URL is unset; the password-reset link will not be usable');
          }
          const url = `${env.publicAppUrl}/reset-password?token=${encodeURIComponent(token)}`;
          const { subject, html, text } = resetPasswordEmail({ name: user.name, url });
          await reportingSendFailures('password-reset', user.email, () =>
            deliveringMailer.send({ to: user.email, subject, html, text }),
          );
        }
      : undefined,
  });
}

// Make a failed auth email findable (TMC-239).
//
// Better Auth dispatches both senders through `runInBackgroundOrAwait`, which
// is `try { await promise } catch (e) { logger.error(…) }` — it catches, logs
// under a generic "Failed to run background task" with no mention of email, and
// returns its neutral 200 anyway. So a configured-but-failing provider (a
// revoked key, a rate limit, a recipient outside a sandbox allowlist) is
// invisible: the user is told to check an inbox nothing is coming to, and the
// operator has no signal that names the problem.
//
// We cannot change what the endpoint returns — that response is BA's, and it is
// deliberately neutral so the page can't be used to enumerate accounts. What we
// can do is refuse to let the failure pass unnamed. The throw is re-raised so
// BA's own handling is unchanged; this only adds the record on the way past.
async function reportingSendFailures(
  kind: 'verification' | 'password-reset',
  to: string,
  send: () => Promise<void>,
): Promise<void> {
  try {
    await send();
  } catch (err) {
    log.error('{kind} email FAILED to send to {to} — the user was told to check their inbox', {
      kind,
      to,
      err: String(err),
    });
    Sentry.captureException(err, { tags: { emailKind: kind } });
    throw err;
  }
}

export type ApiAuth = ReturnType<typeof createApiAuth>;

import { type AccountCreatedContext, type SocialProviderCreds, createAuth } from '@thalermark/auth';
import type { Database } from '@thalermark/db';
import { getLogger } from '@thalermark/logger';
import type { Env } from '../env.js';
import type { Mailer } from './mailer.js';
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
// `hooks` is the open-core account-lifecycle seam: the public composition root
// (server.ts) passes none, so onAccountCreated stays undefined and signup is
// byte-identical to today. A commercial composition root injects a hook that
// provisions the account's initial subscription/trial row inside the signup
// transaction. It's a bag (not a bare positional) so a second lifecycle hook
// later doesn't grow the parameter list. See @thalermark/auth for the seam
// contract (AccountCreatedContext, atomic-with-signup semantics).
export function createApiAuth(
  db: Database,
  env: Env,
  mailer?: Mailer,
  hooks?: { onAccountCreated?: (ctx: AccountCreatedContext) => Promise<void> },
) {
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
    // Open-core seam (see the `hooks` param above). Undefined on self-host, so
    // signup runs exactly as it does with no hook.
    onAccountCreated: hooks?.onAccountCreated,
    ...socialCreds(env),
    // Require email verification when there's a real way to deliver the email,
    // so a self-host install without a mailer isn't locked out. Default = on iff
    // a mailer (Resend) is configured; REQUIRE_EMAIL_VERIFICATION overrides
    // either way. Always off in the test env (the integration suite signs up
    // then immediately uses the session).
    requireEmailVerification:
      env.nodeEnv !== 'test' && (env.requireEmailVerification ?? !!env.resendApiKey),
    // Verification email goes through the same mailer as the rest of the app
    // (Resend or the console driver). Absent in tests (no mailer passed) → the
    // sender is a no-op, which is fine since verification is off there anyway.
    sendVerificationEmail: mailer
      ? async ({ user, url }) => {
          if (!env.publicAppUrl) {
            log.warn(
              'PUBLIC_APP_URL is unset; the email-verification link will redirect to the API origin',
            );
          }
          // Land the post-verify redirect on the web app, not the API origin.
          const link = env.publicAppUrl ? verifyUrlWithAppCallback(url, env.publicAppUrl) : url;
          const { subject, html, text } = verificationEmail({ name: user.name, url: link });
          await mailer.send({ to: user.email, subject, html, text });
        }
      : undefined,
    // Password-reset email through the same mailer. Better Auth gives us the
    // one-time token; we build the link to the web app's /reset-password page
    // from publicAppUrl so the server (not the client) owns the target — the
    // same link works whether the reset was requested from web or mobile, and
    // whatever device opens the email lands on the universal web page. Disabled
    // (BA returns RESET_PASSWORD_DISABLED) when no mailer is configured.
    sendResetPassword: mailer
      ? async ({ user, token }) => {
          if (!env.publicAppUrl) {
            log.warn('PUBLIC_APP_URL is unset; the password-reset link will not be usable');
          }
          const url = `${env.publicAppUrl}/reset-password?token=${encodeURIComponent(token)}`;
          const { subject, html, text } = resetPasswordEmail({ name: user.name, url });
          await mailer.send({ to: user.email, subject, html, text });
        }
      : undefined,
  });
}

export type ApiAuth = ReturnType<typeof createApiAuth>;

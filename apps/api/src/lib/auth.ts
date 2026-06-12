import { type SocialProviderCreds, createAuth } from '@thalermark/auth';
import type { Database } from '@thalermark/db';
import type { Env } from '../env.js';

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

// Thin wrapper around @thalermark/auth's createAuth: pulls config out of the
// loaded env. server.ts holds the resulting handle and passes it into the
// Hono factory.
export function createApiAuth(db: Database, env: Env) {
  return createAuth(db, {
    secret: env.betterAuthSecret,
    baseURL: env.betterAuthUrl,
    trustedOrigins: env.trustedOrigins,
    ...socialCreds(env),
  });
}

export type ApiAuth = ReturnType<typeof createApiAuth>;

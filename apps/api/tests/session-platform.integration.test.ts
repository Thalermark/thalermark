import { authSession, authUser } from '@thalermark/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// Session-origin tag (TMCLD-102). Every session is stamped at creation with the
// client family that opened it — 'web' vs 'mobile' — derived from the request
// Origin: the mobile app pins its app scheme (thalermark://) as Origin on every
// request, a browser sends an http(s) origin. This lets a commercial layer scope
// revocation (a web sign-out that ends app/dashboard/admin but spares the
// long-lived mobile session) WITHOUT the fragile user_agent string-matching that
// class of auth decision must never rely on. Always on (self-host included) —
// platform is session metadata like ip_address/user_agent, not a seam.

const baseEnv: Env = {
  nodeEnv: 'test',
  port: 3000,
  logLevel: 'info',
  errorTrackingDsn: undefined,
  release: undefined,
  databaseUrl: '',
  appDatabaseUrl: '',
  appRolePassword: undefined,
  migrateOnBoot: false,
  betterAuthSecret: 'test-secret-at-least-32-characters-long',
  betterAuthUrl: 'http://localhost:3000',
  trustedOrigins: [],
  publicAppUrl: 'http://localhost:5173',
  resendApiKey: undefined,
  emailFrom: 'Thalermark <test@thalermark.test>',
  stripeSecretKey: undefined,
  stripePublishableKey: undefined,
  stripeWebhookSecret: undefined,
  recurringSweepCron: '0 6 * * *',
};

// The mobile app scheme must be a trusted origin for Better Auth's CSRF check to
// accept the sign-up POST that carries it (self-host does this via TRUSTED_ORIGINS).
function buildApp(trustedOrigins: string[] = []) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const handle = createApiDatabase(appDatabaseUrl());
  const auth = createApiAuth(getTestDb(), { ...baseEnv, databaseUrl: url, trustedOrigins });
  const app = createApp({ auth, db: handle.db, bootstrapDb: getTestDb() });
  return { app, handle };
}

// Sign up (verification is off in test, so BA establishes a session inline).
// `origin` is the request Origin the platform tag is derived from; omit it to
// model a request with no Origin header (falls back to 'web').
function signUp(app: ReturnType<typeof createApp>, email: string, origin?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (origin) headers.origin = origin;
  return app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      email,
      password: 'correct horse battery staple',
      name: 'Platform User',
    }),
  });
}

async function platformFor(email: string): Promise<string | null> {
  const db = getTestDb();
  const [user] = await db
    .select({ id: authUser.id })
    .from(authUser)
    .where(eq(authUser.email, email));
  if (!user) throw new Error('user not seeded');
  const [session] = await db
    .select({ platform: authSession.platform })
    .from(authSession)
    .where(eq(authSession.userId, user.id));
  return session?.platform ?? null;
}

describe('session platform tag (TMCLD-102)', () => {
  beforeEach(resetDb);

  it("stamps a mobile sign-in 'mobile' from the app-scheme Origin", async () => {
    const ctx = buildApp(['thalermark://']);
    try {
      const res = await signUp(ctx.app, 'mobile@example.com', 'thalermark://');
      expect(res.status).toBe(200);
      expect(await platformFor('mobile@example.com')).toBe('mobile');
    } finally {
      await ctx.handle.close();
    }
  });

  it("stamps a browser sign-in 'web' from an http(s) Origin", async () => {
    const ctx = buildApp();
    try {
      const res = await signUp(ctx.app, 'web@example.com', 'http://localhost:5173');
      expect(res.status).toBe(200);
      expect(await platformFor('web@example.com')).toBe('web');
    } finally {
      await ctx.handle.close();
    }
  });

  it("falls back to 'web' when the request carries no Origin (fail-safe)", async () => {
    const ctx = buildApp();
    try {
      const res = await signUp(ctx.app, 'noorigin@example.com');
      expect(res.status).toBe(200);
      expect(await platformFor('noorigin@example.com')).toBe('web');
    } finally {
      await ctx.handle.close();
    }
  });
});

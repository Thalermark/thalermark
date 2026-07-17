import type { SessionRevokedContext } from '@thalermark/auth';
import { authUser } from '@thalermark/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// Open-core single-logout seam (TMCLD-98), at the createApiAuth layer the
// running API actually constructs auth with. Proves the api wrapper THREADS an
// injected onSessionRevoked hook through to Better Auth's session lifecycle: it
// fires when a session ends (sign-out), carries the ended session's user, and a
// failing hook can't break the sign-out. The public build (server.ts) passes
// none, so sign-out is byte-identical. A commercial root injects the hook to
// fan a logout out to its sibling OIDC clients (dashboard/admin).

const testEnv: Env = {
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

// hook omitted → createApiAuth passes no onSessionRevoked (the community
// default: sign-out ends the local session and notifies nothing).
function buildApp(onSessionRevoked?: (ctx: SessionRevokedContext) => Promise<void>) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const handle = createApiDatabase(appDatabaseUrl());
  const auth = createApiAuth(
    getTestDb(),
    { ...testEnv, databaseUrl: url },
    undefined,
    onSessionRevoked ? { onSessionRevoked } : undefined,
  );
  const app = createApp({ auth, db: handle.db, bootstrapDb: getTestDb() });
  return { app, handle };
}

// Sign up (verification is off in test, so BA establishes a session and sets the
// cookie) and hand back the Cookie header to replay on the sign-out request.
async function signUpWithCookie(app: ReturnType<typeof createApp>, email: string) {
  const res = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct horse battery staple', name: 'Logout User' }),
  });
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  return { res, cookie };
}

function signOut(app: ReturnType<typeof createApp>, cookie: string) {
  return app.request('/api/auth/sign-out', { method: 'POST', headers: { cookie } });
}

// The delete hook runs off Better Auth's session lifecycle; poll briefly so the
// test doesn't depend on whether it's awaited inline with the sign-out response.
async function waitFor(predicate: () => boolean, timeoutMs = 1000) {
  const start = Date.now();
  while (!predicate() && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('createApiAuth — onSessionRevoked seam pass-through', () => {
  beforeEach(resetDb);

  it('forwards an injected hook: it fires on sign-out with the ended session user', async () => {
    const db = getTestDb();
    const calls: SessionRevokedContext[] = [];
    const ctx = buildApp(async (c) => {
      calls.push(c);
    });
    try {
      const { cookie } = await signUpWithCookie(ctx.app, 'logout@example.com');
      const [user] = await db
        .select({ id: authUser.id })
        .from(authUser)
        .where(eq(authUser.email, 'logout@example.com'));
      if (!user) throw new Error('user not seeded');

      const out = await signOut(ctx.app, cookie);
      expect(out.status).toBe(200);

      await waitFor(() => calls.length > 0);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.userId).toBe(user.id);
      expect(calls[0]?.sessionId).toBeTruthy();
    } finally {
      await ctx.handle.close();
    }
  });

  it('a throwing forwarded hook does not break sign-out (best-effort)', async () => {
    const ctx = buildApp(async () => {
      throw new Error('commercial logout fan-out failed');
    });
    try {
      const { cookie } = await signUpWithCookie(ctx.app, 'throws@example.com');
      const out = await signOut(ctx.app, cookie);
      // The seam swallows a hook failure, so the user is still signed out cleanly.
      expect(out.status).toBe(200);
    } finally {
      await ctx.handle.close();
    }
  });

  it('the community default (no hook) signs out normally', async () => {
    const ctx = buildApp();
    try {
      const { cookie } = await signUpWithCookie(ctx.app, 'nohook@example.com');
      const out = await signOut(ctx.app, cookie);
      expect(out.status).toBe(200);
    } finally {
      await ctx.handle.close();
    }
  });
});

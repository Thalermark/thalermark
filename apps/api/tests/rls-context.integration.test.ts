import { randomUUID } from 'node:crypto';
import { accounts, authUser, memberships } from '@thalermark/db';
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

const testEnv: Env = {
  nodeEnv: 'test',
  port: 3000,
  logLevel: 'info',
  errorTrackingDsn: undefined,
  release: undefined,
  databaseUrl: '', // overwritten per test
  appDatabaseUrl: '',
  appRolePassword: undefined,
  migrateOnBoot: false,
  betterAuthSecret: 'test-secret-at-least-32-characters-long',
  betterAuthUrl: 'http://localhost:3000',
  trustedOrigins: [],
  publicAppUrl: '',
  resendApiKey: undefined,
  emailFrom: 'Thalermark <test@thalermark.test>',
  stripeSecretKey: undefined,
  stripePublishableKey: undefined,
  stripeWebhookSecret: undefined,
  recurringSweepCron: '0 6 * * *',
};

function extractSessionCookie(res: Response): string {
  // Node 22+ exposes getSetCookie(); fall back to single header otherwise.
  const list =
    (res.headers as { getSetCookie?: () => string[] }).getSetCookie?.() ??
    [res.headers.get('set-cookie') ?? ''].filter(Boolean);
  return list.map((c) => c.split(';')[0]).join('; ');
}

async function signUp(app: ReturnType<typeof createApp>, email: string) {
  const res = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct horse battery staple', name: 'Test' }),
  });
  if (res.status !== 200) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  return extractSessionCookie(res);
}

async function seedAccountAndMembership(userId: string): Promise<string> {
  const db = getTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: 'Test Account' });
  await db.insert(memberships).values({ id: randomUUID(), userId, accountId });
  return accountId;
}

function buildApp() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const handle = createApiDatabase(appDatabaseUrl());
  const auth = createApiAuth(getTestDb(), { ...testEnv, databaseUrl: url });
  const app = createApp({ auth, db: handle.db, bootstrapDb: getTestDb() });
  return { app, handle };
}

describe('rls-context middleware', () => {
  beforeEach(resetDb);

  it('returns 200 on /health without a session (public)', async () => {
    const { app, handle } = buildApp();
    try {
      const res = await app.request('/health');
      expect(res.status).toBe(200);
    } finally {
      await handle.close();
    }
  });

  it('returns 401 on /api/me without a session', async () => {
    const { app, handle } = buildApp();
    try {
      const res = await app.request('/api/me');
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    } finally {
      await handle.close();
    }
  });

  it('returns 200 on /api/me with a session and no x-account-id', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'me-bootstrap@example.com');
      const res = await app.request('/api/me', { headers: { cookie } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { user: { email: string }; memberships: unknown[] };
      expect(body.user.email).toBe('me-bootstrap@example.com');
      // Signup hook auto-seeds a starter account + membership.
      expect(body.memberships).toHaveLength(1);
    } finally {
      await handle.close();
    }
  });

  it('returns 400 on an account-scoped route without x-account-id', async () => {
    const { app, handle } = buildApp();
    app.get('/api/echo', (c) => c.json({ ok: true }));
    try {
      const cookie = await signUp(app, 'no-header@example.com');
      const res = await app.request('/api/echo', { headers: { cookie } });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'account_required' });
    } finally {
      await handle.close();
    }
  });

  it('returns 400 on malformed x-account-id', async () => {
    const { app, handle } = buildApp();
    app.get('/api/echo', (c) => c.json({ ok: true }));
    try {
      const cookie = await signUp(app, 'bad-header@example.com');
      const res = await app.request('/api/echo', {
        headers: { cookie, 'x-account-id': 'not-a-uuid' },
      });
      expect(res.status).toBe(400);
    } finally {
      await handle.close();
    }
  });

  it('returns 403 when x-account-id is a valid uuid but user is not a member', async () => {
    const { app, handle } = buildApp();
    app.get('/api/echo', (c) => c.json({ ok: true }));
    try {
      const cookie = await signUp(app, 'not-a-member@example.com');
      const stranger = randomUUID();
      const res = await app.request('/api/echo', {
        headers: { cookie, 'x-account-id': stranger },
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'account_revoked' });
    } finally {
      await handle.close();
    }
  });

  it('exposes accountId, userId, and a live tx to the route handler', async () => {
    const { app, handle } = buildApp();
    app.get('/api/echo', async (c) => {
      const tx = c.get('tx');
      const guc = await tx.execute<{ v: string | null }>(
        sql`SELECT current_setting('app.current_account_id', true) AS v`,
      );
      return c.json({
        accountId: c.get('accountId'),
        userId: c.get('userId'),
        hasTx: tx !== undefined,
        guc: guc.rows[0]?.v,
      });
    });
    try {
      const cookie = await signUp(app, 'happy-path@example.com');
      const db = getTestDb();
      const [user] = await db
        .select({ id: authUser.id })
        .from(authUser)
        .where(eq(authUser.email, 'happy-path@example.com'));
      if (!user) throw new Error('signed-up user not found');
      const accountId = await seedAccountAndMembership(user.id);
      const res = await app.request('/api/echo', {
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        accountId,
        userId: user.id,
        hasTx: true,
        guc: accountId,
      });
    } finally {
      await handle.close();
    }
  });
});

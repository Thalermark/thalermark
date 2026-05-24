import { accounts, auditEvents, authUser, memberships } from '@thalermark/db';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { getTestDb, resetDb } from './test-helper.js';

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
  publicAppUrl: '',
};

function extractSessionCookie(res: Response): string {
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
  const accountId = uuidv7();
  await db.insert(accounts).values({ id: accountId, name: 'Test Account' });
  await db.insert(memberships).values({ id: uuidv7(), userId, accountId });
  return accountId;
}

function buildApp(scheduleFlush?: (db: unknown, accountId: string) => void) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const handle = createApiDatabase(url);
  const auth = createApiAuth(handle.db, { ...testEnv, databaseUrl: url });
  const app = createApp({
    auth,
    db: handle.db,
    scheduleFlush: scheduleFlush as Parameters<typeof createApp>[0]['scheduleFlush'],
  });
  return { app, handle };
}

describe('audit middleware wiring', () => {
  beforeEach(resetDb);

  it('writes an audit row when the handler calls c.var.audit() and schedules flush', async () => {
    const scheduleFlush = vi.fn();
    const { app, handle } = buildApp(scheduleFlush);
    app.post('/api/__test/audit-probe', async (c) => {
      await c.var.audit({
        entityType: 'invoice',
        entityId: uuidv7(),
        action: 'invoice.created',
        after: { status: 'draft' },
      });
      return c.json({ ok: true });
    });
    try {
      const cookie = await signUp(app, 'audit-write@example.com');
      const db = getTestDb();
      const [user] = await db
        .select({ id: authUser.id })
        .from(authUser)
        .where(eq(authUser.email, 'audit-write@example.com'));
      if (!user) throw new Error('user not found');
      const accountId = await seedAccountAndMembership(user.id);

      const res = await app.request('/api/__test/audit-probe', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(res.status).toBe(200);

      const rows = await db.select().from(auditEvents).where(eq(auditEvents.accountId, accountId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.actorUserId).toBe(user.id);
      expect(rows[0]?.entityType).toBe('invoice');
      expect(rows[0]?.action).toBe('invoice.created');
      expect(rows[0]?.after).toEqual({ status: 'draft' });

      expect(scheduleFlush).toHaveBeenCalledTimes(1);
      expect(scheduleFlush).toHaveBeenCalledWith(handle.db, accountId);
    } finally {
      await handle.close();
    }
  });

  it('skips telemetry flush when the handler never calls audit()', async () => {
    const scheduleFlush = vi.fn();
    const { app, handle } = buildApp(scheduleFlush);
    app.get('/api/list', (c) => c.json({ items: [] }));
    try {
      const cookie = await signUp(app, 'audit-skip@example.com');
      const db = getTestDb();
      const [user] = await db
        .select({ id: authUser.id })
        .from(authUser)
        .where(eq(authUser.email, 'audit-skip@example.com'));
      if (!user) throw new Error('user not found');
      const accountId = await seedAccountAndMembership(user.id);

      const res = await app.request('/api/list', {
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(res.status).toBe(200);

      const rows = await db.select().from(auditEvents).where(eq(auditEvents.accountId, accountId));
      expect(rows).toHaveLength(0);
      expect(scheduleFlush).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('rolls back the audit row when the handler throws after calling audit()', async () => {
    const scheduleFlush = vi.fn();
    const { app, handle } = buildApp(scheduleFlush);
    app.post('/api/boom', async (c) => {
      await c.var.audit({
        entityType: 'invoice',
        entityId: uuidv7(),
        action: 'invoice.created',
      });
      throw new Error('handler exploded');
    });
    try {
      const cookie = await signUp(app, 'audit-rollback@example.com');
      const db = getTestDb();
      const [user] = await db
        .select({ id: authUser.id })
        .from(authUser)
        .where(eq(authUser.email, 'audit-rollback@example.com'));
      if (!user) throw new Error('user not found');
      const accountId = await seedAccountAndMembership(user.id);

      const res = await app.request('/api/boom', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(res.status).toBe(500);

      const rows = await db.select().from(auditEvents).where(eq(auditEvents.accountId, accountId));
      expect(rows).toHaveLength(0);
      // Tx threw, so middleware never reaches the post-commit flush schedule.
      expect(scheduleFlush).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });
});

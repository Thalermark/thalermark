import { accounts, auditEvents, authUser, memberships, telemetryEvents } from '@thalermark/db';
import { emit } from '@thalermark/telemetry';
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

// Full Phase 3 pipeline: sign-up → bootstrap /api/me → seed account →
// enable telemetry → authed mutating request that calls emit() + audit() →
// observe audit row + telemetry queue row + after-commit flush trigger.
// Each prior slice tests its own seam in isolation; this one proves they
// wire together end-to-end.
describe('Phase 3 e2e pipeline', () => {
  beforeEach(resetDb);

  it('signs up, bootstraps, writes audit + telemetry, schedules flush', async () => {
    const scheduleFlush = vi.fn();
    const { app, handle } = buildApp(scheduleFlush);
    app.post('/api/invoices', async (c) => {
      await emit(c.var.tx, { name: 'invoice_created', line_item_count: 3 });
      await c.var.audit({
        entityType: 'invoice',
        entityId: uuidv7(),
        action: 'invoice.created',
        after: { status: 'draft' },
      });
      return c.json({ ok: true });
    });
    try {
      const cookie = await signUp(app, 'pipeline@example.com');

      const meRes = await app.request('/api/me', { headers: { cookie } });
      expect(meRes.status).toBe(200);
      const me = (await meRes.json()) as {
        user: { id: string; email: string };
        memberships: unknown[];
      };
      expect(me.user.email).toBe('pipeline@example.com');
      // Signup hook auto-seeded an account; replace it with the purpose-built
      // telemetry-enabled tenant this test needs. emit() relies on RLS to
      // scope its accounts SELECT to one row, and the API tests run as
      // superuser, so we keep exactly one account present for the request.
      const db = getTestDb();
      await db.delete(accounts);
      const accountId = uuidv7();
      await db.insert(accounts).values({
        id: accountId,
        name: 'Pipeline Co',
        telemetryEnabled: true,
        telemetryInstallId: uuidv7(),
      });
      await db.insert(memberships).values({ id: uuidv7(), userId: me.user.id, accountId });

      const meAfter = await app.request('/api/me', { headers: { cookie } });
      const meAfterBody = (await meAfter.json()) as {
        memberships: { accountId: string; name: string }[];
      };
      expect(meAfterBody.memberships).toEqual([{ accountId, name: 'Pipeline Co' }]);

      const res = await app.request('/api/invoices', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(res.status).toBe(200);

      const audit = await db.select().from(auditEvents).where(eq(auditEvents.accountId, accountId));
      expect(audit).toHaveLength(1);
      expect(audit[0]?.actorUserId).toBe(me.user.id);
      expect(audit[0]?.action).toBe('invoice.created');

      const telemetry = await db
        .select()
        .from(telemetryEvents)
        .where(eq(telemetryEvents.accountId, accountId));
      expect(telemetry).toHaveLength(1);
      expect(telemetry[0]?.eventName).toBe('invoice_created');

      expect(scheduleFlush).toHaveBeenCalledTimes(1);
      expect(scheduleFlush).toHaveBeenCalledWith(handle.db, accountId);

      const userRow = await db
        .select({ id: authUser.id })
        .from(authUser)
        .where(eq(authUser.email, 'pipeline@example.com'));
      expect(userRow[0]?.id).toBe(me.user.id);
    } finally {
      await handle.close();
    }
  });
});

import { accounts, authUser, companies, memberships, telemetryEvents } from '@thalermark/db';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// Telemetry consent + server-side emit (TELEMETRY.md). The transport stays off
// (TELEMETRY_TRANSPORT_ENABLED unset), so events stage locally in
// telemetry_events and never leave the host — these tests assert the staging
// behavior directly via the superuser db.

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

function extractSessionCookie(res: Response): string {
  const list =
    (res.headers as { getSetCookie?: () => string[] }).getSetCookie?.() ??
    [res.headers.get('set-cookie') ?? ''].filter(Boolean);
  return list.map((c) => c.split(';')[0]).join('; ');
}

function buildApp() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const handle = createApiDatabase(appDatabaseUrl());
  const auth = createApiAuth(getTestDb(), { ...testEnv, databaseUrl: url });
  const app = createApp({
    auth,
    db: handle.db,
    bootstrapDb: getTestDb(),
    publicAppUrl: testEnv.publicAppUrl,
  });
  return { app, handle };
}

async function signUp(app: ReturnType<typeof createApp>, email: string) {
  const res = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct horse battery staple', name: email }),
  });
  if (res.status !== 200) throw new Error(`sign-up failed: ${res.status}`);
  return extractSessionCookie(res);
}

async function userContext(email: string) {
  const db = getTestDb();
  const [user] = await db
    .select({ id: authUser.id })
    .from(authUser)
    .where(eq(authUser.email, email));
  if (!user) throw new Error(`user ${email} not seeded`);
  const [m] = await db
    .select({ accountId: memberships.accountId })
    .from(memberships)
    .where(eq(memberships.userId, user.id));
  if (!m) throw new Error(`membership for ${email} not seeded`);
  const [c] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.accountId, m.accountId));
  if (!c) throw new Error(`company for ${email} not seeded`);
  return { userId: user.id, accountId: m.accountId, companyId: c.id };
}

type TelemetryState = { enabled: boolean; decided: boolean; disabled: boolean };

describe('telemetry consent + server emit', () => {
  beforeEach(resetDb);

  it('defaults to opted-out and not-decided', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'tel-default@example.com');
      const { accountId } = await userContext('tel-default@example.com');
      const res = await ctx.app.request('/api/account/telemetry', {
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(res.status).toBe(200);
      expect((await res.json()) as TelemetryState).toEqual({
        enabled: false,
        decided: false,
        disabled: false,
      });
    } finally {
      await ctx.handle.close();
    }
  });

  it('opt-in stages a feature-usage event; opt-out marks decided and purges the queue', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'tel-optin@example.com');
      const { accountId, companyId } = await userContext('tel-optin@example.com');
      const headers = { cookie, 'x-account-id': accountId, 'content-type': 'application/json' };

      const enable = await ctx.app.request('/api/account/telemetry', {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ enabled: true }),
      });
      expect(enable.status).toBe(200);
      expect((await enable.json()) as TelemetryState).toMatchObject({
        enabled: true,
        decided: true,
      });

      // A server mutation now stages its event.
      const customer = await ctx.app.request('/api/contacts', {
        method: 'POST',
        headers,
        body: JSON.stringify({ companyId, name: 'Acme' }),
      });
      expect(customer.status).toBe(201);

      const staged = await getTestDb().select().from(telemetryEvents);
      expect(staged.map((r) => r.eventName)).toContain('client_created');

      // Opt out: decided stays true (prompt won't reappear), queue is purged.
      const disable = await ctx.app.request('/api/account/telemetry', {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ enabled: false }),
      });
      expect((await disable.json()) as TelemetryState).toMatchObject({
        enabled: false,
        decided: true,
      });
      expect(await getTestDb().select().from(telemetryEvents)).toEqual([]);
    } finally {
      await ctx.handle.close();
    }
  });

  it('stages nothing for an account that never opted in', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'tel-off@example.com');
      const { accountId, companyId } = await userContext('tel-off@example.com');
      const res = await ctx.app.request('/api/contacts', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({ companyId, name: 'Nobody' }),
      });
      expect(res.status).toBe(201);
      expect(await getTestDb().select().from(telemetryEvents)).toEqual([]);
    } finally {
      await ctx.handle.close();
    }
  });

  it('TELEMETRY_DISABLED forces off: GET reports disabled, PATCH-enable is collapsed, nothing stages', async () => {
    const ctx = buildApp();
    vi.stubEnv('TELEMETRY_DISABLED', 'true');
    try {
      const cookie = await signUp(ctx.app, 'tel-disabled@example.com');
      const { accountId, companyId } = await userContext('tel-disabled@example.com');
      const headers = { cookie, 'x-account-id': accountId, 'content-type': 'application/json' };

      const get = await ctx.app.request('/api/account/telemetry', {
        headers: { cookie, 'x-account-id': accountId },
      });
      expect((await get.json()) as TelemetryState).toMatchObject({ disabled: true });

      const enable = await ctx.app.request('/api/account/telemetry', {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ enabled: true }),
      });
      // Enable is collapsed to a decided opt-out — collection never arms.
      expect((await enable.json()) as TelemetryState).toMatchObject({
        enabled: false,
        disabled: true,
      });

      await ctx.app.request('/api/contacts', {
        method: 'POST',
        headers,
        body: JSON.stringify({ companyId, name: 'Acme' }),
      });
      expect(await getTestDb().select().from(telemetryEvents)).toEqual([]);

      // The account flag was never set to true.
      const [acct] = await getTestDb()
        .select({ enabled: accounts.telemetryEnabled })
        .from(accounts)
        .where(eq(accounts.id, accountId));
      expect(acct?.enabled).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      await ctx.handle.close();
    }
  });

  it('lets a member read consent but forbids changing it (settings:manage)', async () => {
    const ctx = buildApp();
    try {
      await signUp(ctx.app, 'tel-owner@example.com');
      const { accountId } = await userContext('tel-owner@example.com');

      const cookieB = await signUp(ctx.app, 'tel-member@example.com');
      const { userId: userB } = await userContext('tel-member@example.com');
      await getTestDb()
        .insert(memberships)
        .values({ id: uuidv7(), userId: userB, accountId, role: 'member' });
      const headers = {
        cookie: cookieB,
        'x-account-id': accountId,
        'content-type': 'application/json',
      };

      // A member can READ consent (the client emitter needs `enabled`)...
      const get = await ctx.app.request('/api/account/telemetry', { headers });
      expect(get.status).toBe(200);

      // ...but cannot CHANGE the account-wide decision.
      const patch = await ctx.app.request('/api/account/telemetry', {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ enabled: true }),
      });
      expect(patch.status).toBe(403);
    } finally {
      await ctx.handle.close();
    }
  });

  it('client ingest stages events for an opted-in account', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'tel-ingest@example.com');
      const { accountId } = await userContext('tel-ingest@example.com');
      const headers = { cookie, 'x-account-id': accountId, 'content-type': 'application/json' };

      await ctx.app.request('/api/account/telemetry', {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ enabled: true }),
      });

      const res = await ctx.app.request('/api/telemetry/ingest', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          events: [
            { name: 'report_viewed', report_type: 'profit-and-loss' },
            { name: 'report_viewed', report_type: 'ar-aging' },
          ],
        }),
      });
      expect(res.status).toBe(200);
      expect((await res.json()) as { accepted: number }).toEqual({ accepted: 2 });

      const staged = await getTestDb().select().from(telemetryEvents);
      expect(staged.map((r) => r.eventName)).toEqual(['report_viewed', 'report_viewed']);
      expect(staged.map((r) => (r.payload as { report_type: string }).report_type).sort()).toEqual([
        'ar-aging',
        'profit-and-loss',
      ]);
    } finally {
      await ctx.handle.close();
    }
  });

  it('client ingest stages nothing for an opted-out account (server-side gate)', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'tel-ingest-off@example.com');
      const { accountId } = await userContext('tel-ingest-off@example.com');
      const res = await ctx.app.request('/api/telemetry/ingest', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({ events: [{ name: 'report_viewed', report_type: 'sales-tax' }] }),
      });
      // Best-effort accepted, but emit() drops it — nothing stages.
      expect(res.status).toBe(200);
      expect(await getTestDb().select().from(telemetryEvents)).toEqual([]);
    } finally {
      await ctx.handle.close();
    }
  });

  it('client ingest rejects an unwired/invalid event shape with 400', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'tel-ingest-bad@example.com');
      const { accountId } = await userContext('tel-ingest-bad@example.com');
      const headers = { cookie, 'x-account-id': accountId, 'content-type': 'application/json' };

      const unknownName = await ctx.app.request('/api/telemetry/ingest', {
        method: 'POST',
        headers,
        body: JSON.stringify({ events: [{ name: 'session_start', deployment_type: 'cloud' }] }),
      });
      expect(unknownName.status).toBe(400);

      const badReport = await ctx.app.request('/api/telemetry/ingest', {
        method: 'POST',
        headers,
        body: JSON.stringify({ events: [{ name: 'report_viewed', report_type: 'not-a-report' }] }),
      });
      expect(badReport.status).toBe(400);

      const empty = await ctx.app.request('/api/telemetry/ingest', {
        method: 'POST',
        headers,
        body: JSON.stringify({ events: [] }),
      });
      expect(empty.status).toBe(400);
    } finally {
      await ctx.handle.close();
    }
  });
});

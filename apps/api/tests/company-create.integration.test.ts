import { authUser, memberships } from '@thalermark/db';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// POST /api/companies — the multi-company create path. Adds another business to
// an existing workspace, seeds the chart of accounts for the business type it
// was given, gated by settings:manage. The per-entity chart shapes are covered
// in business-type-chart.integration.test.ts.

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
  return { userId: user.id, accountId: m.accountId };
}

type Company = { id: string; name: string; businessType: string | null };
type Account = { code: string; accountType: string };

describe('POST /api/companies', () => {
  beforeEach(resetDb);

  it('creates a second company, seeds its COA, and lists both', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'create-ok@example.com');
      const { accountId } = await userContext('create-ok@example.com');

      const res = await ctx.app.request('/api/companies', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Handyman LLC', businessType: 'llc_single_member' }),
      });
      expect(res.status).toBe(201);
      const created = (await res.json()) as Company;
      expect(created).toMatchObject({ name: 'Handyman LLC', businessType: 'llc_single_member' });

      // The new company carries its own chart, seeded for the type it was
      // created with (a single-member LLC files Schedule C, same as a sole prop).
      const coa = await ctx.app.request(`/api/companies/${created.id}/accounts`, {
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(coa.status).toBe(200);
      const { accounts } = (await coa.json()) as { accounts: Account[] };
      expect(accounts.length).toBeGreaterThan(0);
      expect(accounts[0]).toMatchObject({ code: '1000', accountType: 'asset' });

      // Both companies now show in the workspace list (signup-seeded + new).
      const list = await ctx.app.request('/api/companies', {
        headers: { cookie, 'x-account-id': accountId },
      });
      const { companies: rows } = (await list.json()) as { companies: Company[] };
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.name)).toContain('Handyman LLC');
    } finally {
      await ctx.handle.close();
    }
  });

  it('rejects a missing name or unknown business type with 400', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'create-bad@example.com');
      const { accountId } = await userContext('create-bad@example.com');
      const headers = { cookie, 'x-account-id': accountId, 'content-type': 'application/json' };

      const noName = await ctx.app.request('/api/companies', {
        method: 'POST',
        headers,
        body: JSON.stringify({ businessType: 'sole_prop' }),
      });
      expect(noName.status).toBe(400);

      const badType = await ctx.app.request('/api/companies', {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'X', businessType: 'partnership_general' }),
      });
      expect(badType.status).toBe(400);
    } finally {
      await ctx.handle.close();
    }
  });

  it('forbids a member (lacking settings:manage) from creating a company', async () => {
    const ctx = buildApp();
    try {
      // Owner of account A (their signup-seeded workspace).
      await signUp(ctx.app, 'create-owner@example.com');
      const { accountId: accountA } = await userContext('create-owner@example.com');

      // A second user, added to account A as a plain member.
      const cookieB = await signUp(ctx.app, 'create-member@example.com');
      const { userId: userB } = await userContext('create-member@example.com');
      await getTestDb()
        .insert(memberships)
        .values({ id: uuidv7(), userId: userB, accountId: accountA, role: 'member' });

      const res = await ctx.app.request('/api/companies', {
        method: 'POST',
        headers: { cookie: cookieB, 'x-account-id': accountA, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Sneaky Co', businessType: 'sole_prop' }),
      });
      expect(res.status).toBe(403);
      expect((await res.json()) as { error: string }).toMatchObject({ error: 'forbidden' });
    } finally {
      await ctx.handle.close();
    }
  });
});

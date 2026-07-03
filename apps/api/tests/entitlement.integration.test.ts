import { authUser, companies, memberships } from '@thalermark/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import type { EntitlementProvider } from '../src/lib/entitlement.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// Open-core entitlement seam (spikes/SAAS-AND-PRODUCTION.md §6.5). Core asks
// entitlement.can(account, feature) at the freeze doors (create/send
// invoice·estimate·expense, recurring generation) and the AI doors; an injected
// provider answers. These tests inject a deny-all provider — standing in for the
// commercial side flipping a feature off on a frozen / non-AI account — and
// assert the gated doors return 402. The "allowed" cases use the community
// default (no provider), which always says yes, so the door never 402s and the
// public build is unrestricted.

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

// Denies every feature — what a frozen (documents:write off) or non-AI (ai off)
// account looks like once the commercial provider answers.
const denyAll: EntitlementProvider = { can: () => false, limit: () => 0 };

function extractSessionCookie(res: Response): string {
  const list =
    (res.headers as { getSetCookie?: () => string[] }).getSetCookie?.() ??
    [res.headers.get('set-cookie') ?? ''].filter(Boolean);
  return list.map((c) => c.split(';')[0]).join('; ');
}

// entitlement omitted → routes fall back to the always-yes community default.
function buildApp(entitlement?: EntitlementProvider) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const handle = createApiDatabase(appDatabaseUrl());
  const auth = createApiAuth(getTestDb(), { ...testEnv, databaseUrl: url });
  const app = createApp({
    auth,
    db: handle.db,
    bootstrapDb: getTestDb(),
    entitlement,
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

async function accountFor(email: string): Promise<string> {
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
  return m.accountId;
}

async function companyFor(accountId: string): Promise<string> {
  const db = getTestDb();
  const [company] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.accountId, accountId));
  if (!company) throw new Error(`company for account ${accountId} not seeded`);
  return company.id;
}

function post(
  app: ReturnType<typeof createApp>,
  path: string,
  cookie: string,
  accountId: string,
  body: Record<string, unknown> = {},
) {
  return app.request(path, {
    method: 'POST',
    headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('entitlement seam — freeze doors (documents:write)', () => {
  beforeEach(resetDb);

  it('402s create-expense when the account is not entitled', async () => {
    const ctx = buildApp(denyAll);
    try {
      const cookie = await signUp(ctx.app, 'deny@example.com');
      const accountId = await accountFor('deny@example.com');
      const res = await post(ctx.app, '/api/expenses', cookie, accountId, {
        amount: '10.00',
        expenseDate: '2026-05-20',
        merchant: 'Home Depot',
      });
      expect(res.status).toBe(402);
      expect(await res.json()).toEqual({ error: 'not_entitled', feature: 'documents:write' });
    } finally {
      await ctx.handle.close();
    }
  });

  it('402s create-invoice when the account is not entitled', async () => {
    const ctx = buildApp(denyAll);
    try {
      const cookie = await signUp(ctx.app, 'deny2@example.com');
      const accountId = await accountFor('deny2@example.com');
      // Gate is middleware ahead of the handler, so the body need not be valid.
      const res = await post(ctx.app, '/api/invoices', cookie, accountId);
      expect(res.status).toBe(402);
      expect(await res.json()).toEqual({ error: 'not_entitled', feature: 'documents:write' });
    } finally {
      await ctx.handle.close();
    }
  });

  it('the community default (no provider) leaves the freeze door open', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'allow@example.com');
      const accountId = await accountFor('allow@example.com');
      // Deliberately invalid body: proves the gate is open (400 from the
      // handler, not 402 from the gate).
      const res = await post(ctx.app, '/api/expenses', cookie, accountId, {});
      expect(res.status).not.toBe(402);
      expect(res.status).toBe(400);
    } finally {
      await ctx.handle.close();
    }
  });
});

describe('entitlement seam — AI doors (ai)', () => {
  beforeEach(resetDb);

  it('402s expense categorize when the account is not entitled to ai', async () => {
    // No categorizer wired, so the handler would 503 — but the ai gate is
    // middleware ahead of it, so a denied account 402s first.
    const ctx = buildApp(denyAll);
    try {
      const cookie = await signUp(ctx.app, 'noai@example.com');
      const accountId = await accountFor('noai@example.com');
      const companyId = await companyFor(accountId);
      const res = await post(ctx.app, '/api/expenses/categorize', cookie, accountId, {
        companyId,
        merchant: 'Shell',
        amount: '40.00',
      });
      expect(res.status).toBe(402);
      expect(await res.json()).toEqual({ error: 'not_entitled', feature: 'ai' });
    } finally {
      await ctx.handle.close();
    }
  });

  it('the community default leaves the ai door open (503 for the missing model, not 402)', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'aiok@example.com');
      const accountId = await accountFor('aiok@example.com');
      const companyId = await companyFor(accountId);
      const res = await post(ctx.app, '/api/expenses/categorize', cookie, accountId, {
        companyId,
        merchant: 'Shell',
        amount: '40.00',
      });
      expect(res.status).not.toBe(402);
      // No categorizer configured in this test → the handler's own 503.
      expect(res.status).toBe(503);
    } finally {
      await ctx.handle.close();
    }
  });
});

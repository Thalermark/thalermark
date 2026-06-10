import { authUser, chartOfAccounts, companies, memberships } from '@thalermark/db';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// Anomaly flagging (deterministic). Exercises
// GET /api/companies/:id/spending-anomalies: recent-vs-baseline overall + per-
// category flags, the threshold/min-dollar gates, the thin-history shape, and
// tenant isolation. Dates are placed relative to "now" so the windows land
// regardless of the run date (60 days ago = baseline, 5 days ago = recent).

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
  const [company] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.accountId, m.accountId));
  if (!company) throw new Error(`company for ${email} not seeded`);
  return { accountId: m.accountId, companyId: company.id };
}

async function coaId(companyId: string, code: string): Promise<string> {
  const db = getTestDb();
  const [row] = await db
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.companyId, companyId), eq(chartOfAccounts.code, code)));
  if (!row) throw new Error(`COA ${code} not seeded`);
  return row.id;
}

type Auth = { cookie: string; accountId: string };

const DAY_MS = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10);

async function expense(
  app: ReturnType<typeof createApp>,
  auth: Auth,
  companyId: string,
  opts: { amount: string; categoryCode: string; expenseDate: string },
) {
  const res = await app.request('/api/expenses', {
    method: 'POST',
    headers: {
      cookie: auth.cookie,
      'x-account-id': auth.accountId,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      companyId,
      categoryAccountId: await coaId(companyId, opts.categoryCode),
      paymentAccountId: await coaId(companyId, '1000'),
      amount: opts.amount,
      expenseDate: opts.expenseDate,
      merchant: 'Vendor',
    }),
  });
  if (res.status !== 201) throw new Error(`expense create failed: ${res.status}`);
}

function anomalies(app: ReturnType<typeof createApp>, auth: Auth, companyId: string) {
  return app.request(`/api/companies/${companyId}/spending-anomalies`, {
    headers: { cookie: auth.cookie, 'x-account-id': auth.accountId },
  });
}

type Anomalies = {
  enoughHistory: boolean;
  overall: { recent: string; typical: string; pctOver: number } | null;
  categories: { code: string; name: string; recent: string; typical: string; pctOver: number }[];
};

beforeEach(resetDb);

describe('spending anomalies', () => {
  it('flags overall and per-category spikes vs the baseline', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'anom@example.com');
      const { accountId, companyId } = await userContext('anom@example.com');
      const auth: Auth = { cookie, accountId };

      // Baseline (60 days ago): $300 Advertising + $300 Supplies → typical/mo
      // = $100 each, $200 overall.
      await expense(ctx.app, auth, companyId, {
        amount: '300.00',
        categoryCode: '6000',
        expenseDate: daysAgo(60),
      });
      await expense(ctx.app, auth, companyId, {
        amount: '300.00',
        categoryCode: '7000',
        expenseDate: daysAgo(60),
      });
      // Recent (5 days ago): Advertising $900 (9x typical → flag), Supplies $90
      // (below the +50% gate → no flag).
      await expense(ctx.app, auth, companyId, {
        amount: '900.00',
        categoryCode: '6000',
        expenseDate: daysAgo(5),
      });
      await expense(ctx.app, auth, companyId, {
        amount: '90.00',
        categoryCode: '7000',
        expenseDate: daysAgo(5),
      });

      const res = await anomalies(ctx.app, auth, companyId);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Anomalies;
      expect(body.enoughHistory).toBe(true);
      // Overall: recent $990 vs typical $200 → +395%.
      expect(body.overall).not.toBeNull();
      expect(body.overall?.pctOver).toBe(395);
      // Only Advertising spikes; Supplies (90 vs typical 100) is below threshold.
      expect(body.categories).toHaveLength(1);
      expect(body.categories[0]?.code).toBe('6000');
      expect(body.categories[0]?.pctOver).toBe(800);
      expect(body.categories[0]?.recent).toBe('900.00');
      expect(body.categories[0]?.typical).toBe('100.00');
    } finally {
      await ctx.handle.close();
    }
  });

  it('reports thin history (no baseline) without flagging', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'anom-new@example.com');
      const { accountId, companyId } = await userContext('anom-new@example.com');
      const auth: Auth = { cookie, accountId };

      // Only recent spend, nothing in the baseline window.
      await expense(ctx.app, auth, companyId, {
        amount: '500.00',
        categoryCode: '6000',
        expenseDate: daysAgo(3),
      });

      const body = (await (await anomalies(ctx.app, auth, companyId)).json()) as Anomalies;
      expect(body.enoughHistory).toBe(false);
      expect(body.overall).toBeNull();
      expect(body.categories).toEqual([]);
    } finally {
      await ctx.handle.close();
    }
  });

  it("404s for another account's company", async () => {
    const ctx = buildApp();
    try {
      await signUp(ctx.app, 'anom-a@example.com');
      const a = await userContext('anom-a@example.com');
      const cookieB = await signUp(ctx.app, 'anom-b@example.com');
      const b = await userContext('anom-b@example.com');

      const res = await anomalies(
        ctx.app,
        { cookie: cookieB, accountId: b.accountId },
        a.companyId,
      );
      expect(res.status).toBe(404);
    } finally {
      await ctx.handle.close();
    }
  });
});

import type { CashFlowAdvisor, CashFlowNudge, CashFlowSignals } from '@thalermark/ai';
import { authUser, chartOfAccounts, companies, memberships } from '@thalermark/db';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// Cash-flow nudges (AI). Exercises GET /api/companies/:id/cash-flow-nudges
// against a stub advisor (no live model): generate-and-cache, the cache hit
// that skips the model, regeneration when the signals change, the AI-disabled
// 503, model-failure 502, and tenant isolation.

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

const SAMPLE: CashFlowNudge[] = [{ text: 'You have cash on hand.', tone: 'good' }];

function extractSessionCookie(res: Response): string {
  const list =
    (res.headers as { getSetCookie?: () => string[] }).getSetCookie?.() ??
    [res.headers.get('set-cookie') ?? ''].filter(Boolean);
  return list.map((c) => c.split(';')[0]).join('; ');
}

// Call counter + last-signals capture so a test can assert the cache prevented
// a second model call and that the route handed over computed figures.
let adviseCalls = 0;
let lastSignals: CashFlowSignals | null = null;

function okAdvisor(nudges: CashFlowNudge[] = SAMPLE): CashFlowAdvisor {
  return {
    async advise(signals) {
      adviseCalls++;
      lastSignals = signals;
      return nudges;
    },
  };
}

const throwingAdvisor: CashFlowAdvisor = {
  async advise(signals) {
    adviseCalls++;
    lastSignals = signals;
    throw new Error('model unavailable');
  },
};

// ai defaults true → the resolver hands the route a dummy credential so it
// reaches the injected stub advisor. ai:false → the resolver returns null (no
// usable credential), so a cache miss 503s — the path that moved from a null
// advisor to a null credential.
function buildApp(opts: { advisor?: CashFlowAdvisor; ai?: boolean } = {}) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const handle = createApiDatabase(appDatabaseUrl());
  const auth = createApiAuth(getTestDb(), { ...testEnv, databaseUrl: url });
  const ai = opts.ai ?? true;
  const app = createApp({
    auth,
    db: handle.db,
    bootstrapDb: getTestDb(),
    publicAppUrl: testEnv.publicAppUrl,
    advisor: opts.advisor ?? okAdvisor(),
    llmCredentials: {
      resolve: async () => (ai ? { provider: 'anthropic', apiKey: 'test-key' } : null),
    },
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

async function createExpense(
  app: ReturnType<typeof createApp>,
  cookie: string,
  accountId: string,
  companyId: string,
  amount: string,
) {
  const res = await app.request('/api/expenses', {
    method: 'POST',
    headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
    body: JSON.stringify({
      companyId,
      categoryAccountId: await coaId(companyId, '6000'),
      paymentAccountId: await coaId(companyId, '1000'),
      amount,
      expenseDate: new Date().toISOString().slice(0, 10),
      merchant: 'Fuel',
    }),
  });
  if (res.status !== 201) throw new Error(`expense create failed: ${res.status}`);
}

async function nudges(
  app: ReturnType<typeof createApp>,
  cookie: string,
  accountId: string,
  companyId: string,
): Promise<Response> {
  return app.request(`/api/companies/${companyId}/cash-flow-nudges`, {
    headers: { cookie, 'x-account-id': accountId },
  });
}

type NudgesBody = { nudges: CashFlowNudge[]; generatedAt: string | null };

beforeEach(async () => {
  await resetDb();
  adviseCalls = 0;
  lastSignals = null;
});

describe('cash-flow nudges', () => {
  it('generates, caches, and hands the advisor computed signals', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'nudge@example.com');
      const { accountId, companyId } = await userContext('nudge@example.com');

      const res = await nudges(ctx.app, cookie, accountId, companyId);
      expect(res.status).toBe(200);
      const body = (await res.json()) as NudgesBody;
      expect(body.nudges).toEqual(SAMPLE);
      expect(body.generatedAt).not.toBeNull();
      expect(adviseCalls).toBe(1);
      // The route computed deterministic signals (not the LLM).
      expect(lastSignals?.cashOnHand).toBe('0.00');
      expect(lastSignals?.trailingMonths).toHaveLength(3);
      // A fresh company has no business type yet, and the key must still be
      // PRESENT and null — it is part of the hashed signals struct, so a route
      // that omitted it would restore the pre-change cache key. This is also the
      // assertion that would have caught the original defect (the persona never
      // reaching the prompt at all).
      expect(lastSignals).toHaveProperty('businessType');
      expect(lastSignals?.businessType).toBeNull();
    } finally {
      await ctx.handle.close();
    }
  });

  it('serves the cache on an unchanged second call without re-running the model', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'nudge-cache@example.com');
      const { accountId, companyId } = await userContext('nudge-cache@example.com');

      const first = (await (
        await nudges(ctx.app, cookie, accountId, companyId)
      ).json()) as NudgesBody;
      const second = (await (
        await nudges(ctx.app, cookie, accountId, companyId)
      ).json()) as NudgesBody;

      expect(adviseCalls).toBe(1); // second call hit the cache
      expect(second.nudges).toEqual(first.nudges);
      expect(second.generatedAt).toBe(first.generatedAt); // same cached row
    } finally {
      await ctx.handle.close();
    }
  });

  it('regenerates when the signals change (new expense)', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'nudge-regen@example.com');
      const { accountId, companyId } = await userContext('nudge-regen@example.com');

      await nudges(ctx.app, cookie, accountId, companyId);
      expect(adviseCalls).toBe(1);

      // An expense changes cash on hand → the signal hash changes → regenerate.
      await createExpense(ctx.app, cookie, accountId, companyId, '40.00');
      await nudges(ctx.app, cookie, accountId, companyId);
      expect(adviseCalls).toBe(2);
    } finally {
      await ctx.handle.close();
    }
  });

  // The cache-invalidation contract for business type. Without it, a company
  // that incorporated would keep serving nudges written for its old entity
  // until its ledger happened to move — and a later refactor that made the
  // signals key conditional would silently reintroduce exactly that.
  it('hands the advisor the business type and regenerates when it changes', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'nudge-entity@example.com');
      const { accountId, companyId } = await userContext('nudge-entity@example.com');

      await nudges(ctx.app, cookie, accountId, companyId);
      expect(adviseCalls).toBe(1);
      expect(lastSignals?.businessType).toBeNull();

      // Set it in the DB rather than via PATCH /api/companies/:id: that endpoint
      // reconciles the chart of accounts on a business-type change, and coupling
      // this test to COA-overlay internals buys nothing.
      await getTestDb()
        .update(companies)
        .set({ businessType: 's_corp' })
        .where(eq(companies.id, companyId));

      await nudges(ctx.app, cookie, accountId, companyId);
      expect(adviseCalls).toBe(2); // hash changed → no stale sole-trader nudge
      expect(lastSignals?.businessType).toBe('s_corp');
    } finally {
      await ctx.handle.close();
    }
  });

  it('503s when the account has no usable LLM credential and nothing is cached', async () => {
    const ctx = buildApp({ ai: false });
    try {
      const cookie = await signUp(ctx.app, 'nudge-off@example.com');
      const { accountId, companyId } = await userContext('nudge-off@example.com');
      const res = await nudges(ctx.app, cookie, accountId, companyId);
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toBe('ai_not_configured');
    } finally {
      await ctx.handle.close();
    }
  });

  it('502s when the model throws (leaving any prior cache intact)', async () => {
    const ctx = buildApp({ advisor: throwingAdvisor });
    try {
      const cookie = await signUp(ctx.app, 'nudge-fail@example.com');
      const { accountId, companyId } = await userContext('nudge-fail@example.com');
      const res = await nudges(ctx.app, cookie, accountId, companyId);
      expect(res.status).toBe(502);
      expect(((await res.json()) as { error: string }).error).toBe('nudges_failed');
    } finally {
      await ctx.handle.close();
    }
  });

  it("404s for another account's company", async () => {
    const ctx = buildApp();
    try {
      await signUp(ctx.app, 'nudge-a@example.com');
      const { companyId: companyA } = await userContext('nudge-a@example.com');
      const cookieB = await signUp(ctx.app, 'nudge-b@example.com');
      const { accountId: accountB } = await userContext('nudge-b@example.com');

      const res = await nudges(ctx.app, cookieB, accountB, companyA);
      expect(res.status).toBe(404);
    } finally {
      await ctx.handle.close();
    }
  });
});

import { APICallError, type CategorizeInput, type ExpenseCategorizer } from '@thalermark/ai';
import { authUser, chartOfAccounts, companies, memberships } from '@thalermark/db';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { deriveConnectionKey } from '../src/lib/crypto.js';
import { createApiDatabase } from '../src/lib/db.js';
import { type LlmConnectionStore, createLlmConnectionStore } from '../src/lib/llm-connection.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// Text expense categorization. Exercises POST /api/expenses/categorize against a
// stub categorizer (no live model): success path + code→account-id resolution,
// the "no category fit" null path, the AI-disabled 503, invalid-body 400,
// model-failure 502, and tenant isolation (a company from another account 404s).

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

// Captures the input the route hands the categorizer so a test can assert the
// allowed-category set + typed fields were passed through.
let lastInput: CategorizeInput | null = null;

function okCategorizer(code: string | null = '6000'): ExpenseCategorizer {
  return {
    async categorize(input) {
      lastInput = input;
      return { suggestedCategoryCode: code };
    },
  };
}

const throwingCategorizer: ExpenseCategorizer = {
  async categorize(input) {
    lastInput = input;
    throw new Error('model unavailable');
  },
};

// ai defaults true → the resolver hands the route a dummy credential so it
// reaches the injected stub categorizer. ai:false → the resolver returns null,
// so the route 503s (the "AI not configured" path moved from a null categorizer
// to a null credential).
function buildApp(
  opts: { categorizer?: ExpenseCategorizer; ai?: boolean; withHealth?: boolean } = {},
) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const handle = createApiDatabase(appDatabaseUrl());
  const auth = createApiAuth(getTestDb(), { ...testEnv, databaseUrl: url });
  const ai = opts.ai ?? true;
  // Only the live-call-health tests need the store; the rest run without it.
  const store: LlmConnectionStore | undefined = opts.withHealth
    ? createLlmConnectionStore(handle.db, deriveConnectionKey(testEnv.betterAuthSecret))
    : undefined;
  const app = createApp({
    auth,
    db: handle.db,
    bootstrapDb: getTestDb(),
    publicAppUrl: testEnv.publicAppUrl,
    categorizer: opts.categorizer ?? okCategorizer(),
    llmCredentials: {
      resolve: async () => (ai ? { provider: 'anthropic', apiKey: 'test-key' } : null),
    },
    llmConnections: store,
  });
  return { app, handle, store };
}

// The synthetic system user seeded by resetDb — a valid actor for upsert.
const SYSTEM_USER = '00000000-0000-7000-8000-000000000001';

function throwingWith(error: unknown): ExpenseCategorizer {
  return {
    async categorize(input) {
      lastInput = input;
      throw error;
    },
  };
}

function apiError(statusCode: number, isRetryable: boolean, message: string): APICallError {
  return new APICallError({
    message,
    url: 'https://api.example.com/v1/chat/completions',
    requestBodyValues: {},
    statusCode,
    isRetryable,
  });
}

// Seed a verified (ready) connection so a live-call failure has something to flip.
async function seedReadyConnection(store: LlmConnectionStore, accountId: string) {
  await store.upsert(accountId, { provider: 'anthropic', apiKey: 'test-key' }, SYSTEM_USER);
  await store.recordProbeResult(accountId, { ok: true, latencyMs: 1 });
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

function categorize(
  app: ReturnType<typeof createApp>,
  auth: Record<string, string>,
  body: Record<string, unknown>,
) {
  return app.request('/api/expenses/categorize', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await resetDb();
  lastInput = null;
});

describe('expense categorization', () => {
  it('suggests a category and resolves the code to an account id', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'cat@example.com');
      const { accountId, companyId } = await userContext('cat@example.com');
      const res = await categorize(
        ctx.app,
        { cookie, 'x-account-id': accountId },
        { companyId, merchant: 'Home Depot', memo: 'lumber for deck', amount: '42.50' },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        suggestedCategoryCode: string | null;
        suggestedCategoryAccountId: string | null;
      };
      expect(body.suggestedCategoryCode).toBe('6000');
      expect(body.suggestedCategoryAccountId).toBe(await coaId(companyId, '6000'));

      // The route handed the categorizer the typed fields + the company's
      // expense COA to constrain the suggestion.
      expect(lastInput?.merchant).toBe('Home Depot');
      expect(lastInput?.memo).toBe('lumber for deck');
      expect(lastInput?.amount).toBe('42.50');
      expect(lastInput?.allowedCategories.some((c) => c.code === '6000')).toBe(true);
    } finally {
      await ctx.handle.close();
    }
  });

  it('returns nulls when the model finds no fitting category', async () => {
    const ctx = buildApp({ categorizer: okCategorizer(null) });
    try {
      const cookie = await signUp(ctx.app, 'cat-none@example.com');
      const { accountId, companyId } = await userContext('cat-none@example.com');
      const res = await categorize(
        ctx.app,
        { cookie, 'x-account-id': accountId },
        { companyId, merchant: 'Something obscure' },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        suggestedCategoryCode: string | null;
        suggestedCategoryAccountId: string | null;
      };
      expect(body.suggestedCategoryCode).toBeNull();
      expect(body.suggestedCategoryAccountId).toBeNull();
    } finally {
      await ctx.handle.close();
    }
  });

  it('503s when the account has no usable LLM credential', async () => {
    const ctx = buildApp({ ai: false });
    try {
      const cookie = await signUp(ctx.app, 'cat-off@example.com');
      const { accountId, companyId } = await userContext('cat-off@example.com');
      const res = await categorize(
        ctx.app,
        { cookie, 'x-account-id': accountId },
        { companyId, merchant: 'Home Depot' },
      );
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toBe('ai_not_configured');
    } finally {
      await ctx.handle.close();
    }
  });

  it('400s on an invalid body (missing merchant)', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'cat-bad@example.com');
      const { accountId, companyId } = await userContext('cat-bad@example.com');
      const res = await categorize(ctx.app, { cookie, 'x-account-id': accountId }, { companyId });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_body');
    } finally {
      await ctx.handle.close();
    }
  });

  it('502s when the model throws', async () => {
    const ctx = buildApp({ categorizer: throwingCategorizer });
    try {
      const cookie = await signUp(ctx.app, 'cat-fail@example.com');
      const { accountId, companyId } = await userContext('cat-fail@example.com');
      const res = await categorize(
        ctx.app,
        { cookie, 'x-account-id': accountId },
        { companyId, merchant: 'Home Depot' },
      );
      expect(res.status).toBe(502);
      expect(((await res.json()) as { error: string }).error).toBe('categorization_failed');
    } finally {
      await ctx.handle.close();
    }
  });

  it('404s for a company belonging to another account', async () => {
    const ctx = buildApp();
    try {
      await signUp(ctx.app, 'cat-a@example.com');
      const { companyId: companyA } = await userContext('cat-a@example.com');

      const cookieB = await signUp(ctx.app, 'cat-b@example.com');
      const { accountId: accountB } = await userContext('cat-b@example.com');

      // Account B asks to categorize against account A's company.
      const res = await categorize(
        ctx.app,
        { cookie: cookieB, 'x-account-id': accountB },
        { companyId: companyA, merchant: 'Home Depot' },
      );
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toBe('company_not_found');
    } finally {
      await ctx.handle.close();
    }
  });
});

describe('expense categorization — live-call health', () => {
  it('a permanent failure (401) reddens the connection', async () => {
    const ctx = buildApp({
      withHealth: true,
      categorizer: throwingWith(apiError(401, false, 'invalid x-api-key')),
    });
    if (!ctx.store) throw new Error('store expected');
    try {
      const cookie = await signUp(ctx.app, 'h401@example.com');
      const { accountId, companyId } = await userContext('h401@example.com');
      await seedReadyConnection(ctx.store, accountId);
      expect((await ctx.store.getDisplay(accountId))?.status).toBe('ready');

      const res = await categorize(
        ctx.app,
        { cookie, 'x-account-id': accountId },
        { companyId, merchant: 'Shell', amount: '40.00' },
      );
      expect(res.status).toBe(502);
      const conn = await ctx.store.getDisplay(accountId);
      expect(conn?.status).toBe('error');
      expect(conn?.lastError).toContain('invalid x-api-key');
      // Sticky — a bad key reddens the chip but AI is not knocked out.
      expect(await ctx.store.getUsable(accountId)).not.toBeNull();
    } finally {
      await ctx.handle.close();
    }
  });

  it('a transient failure (503) leaves the connection healthy', async () => {
    const ctx = buildApp({
      withHealth: true,
      categorizer: throwingWith(apiError(503, true, 'overloaded')),
    });
    if (!ctx.store) throw new Error('store expected');
    try {
      const cookie = await signUp(ctx.app, 'h503@example.com');
      const { accountId, companyId } = await userContext('h503@example.com');
      await seedReadyConnection(ctx.store, accountId);

      const res = await categorize(
        ctx.app,
        { cookie, 'x-account-id': accountId },
        { companyId, merchant: 'Shell', amount: '40.00' },
      );
      expect(res.status).toBe(502);
      // A blip must NOT demote a working connection.
      expect((await ctx.store.getDisplay(accountId))?.status).toBe('ready');
    } finally {
      await ctx.handle.close();
    }
  });
});

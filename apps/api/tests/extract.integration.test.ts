import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtractionInput, ExtractionResult, ReceiptExtractor } from '@thalermark/ai';
import { authUser, chartOfAccounts, companies, expenses, memberships } from '@thalermark/db';
import { createLocalFsProvider } from '@thalermark/storage';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { getTestDb, resetDb } from './test-helper.js';

// 8.9h — receipt extraction. Exercises POST /api/expenses/:id/extract against a
// stub extractor (no live model) + the local-FS storage adapter: success path,
// the AI-disabled 503, no-receipt 400, model-failure 502, and tenant isolation.

const SECRET = 'test-secret-at-least-32-characters-long';

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
};

const SAMPLE_RESULT: ExtractionResult = {
  merchant: 'Acme Tools',
  total: '19.99',
  expenseDate: '2026-05-02',
  taxAmount: '1.60',
  suggestedCategoryCode: '6000',
};

function extractSessionCookie(res: Response): string {
  const list =
    (res.headers as { getSetCookie?: () => string[] }).getSetCookie?.() ??
    [res.headers.get('set-cookie') ?? ''].filter(Boolean);
  return list.map((c) => c.split(';')[0]).join('; ');
}

let storageDir: string;
// Captures the input the route hands the extractor so a test can assert the
// allowed-category set was passed through.
let lastInput: ExtractionInput | null = null;

function okExtractor(result: ExtractionResult = SAMPLE_RESULT): ReceiptExtractor {
  return {
    async extractReceipt(input) {
      lastInput = input;
      return result;
    },
  };
}

const throwingExtractor: ReceiptExtractor = {
  async extractReceipt(input) {
    lastInput = input;
    throw new Error('model unavailable');
  },
};

function buildApp(opts: { extractor?: ReceiptExtractor | null; withStorage?: boolean } = {}) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const handle = createApiDatabase(url);
  const auth = createApiAuth(handle.db, { ...testEnv, databaseUrl: url });
  const withStorage = opts.withStorage ?? true;
  const app = createApp({
    auth,
    db: handle.db,
    publicAppUrl: testEnv.publicAppUrl,
    storage: withStorage ? createLocalFsProvider({ baseDir: storageDir, secret: SECRET }) : null,
    localFileServe: withStorage ? { secret: SECRET, baseDir: storageDir } : null,
    extractor: opts.extractor === undefined ? okExtractor() : opts.extractor,
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
): Promise<string> {
  const category = await coaId(companyId, '6000');
  const payment = await coaId(companyId, '1000');
  const res = await app.request('/api/expenses', {
    method: 'POST',
    headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
    body: JSON.stringify({
      companyId,
      categoryAccountId: category,
      paymentAccountId: payment,
      amount: '42.50',
      expenseDate: '2026-05-20',
      merchant: 'Home Depot',
    }),
  });
  if (res.status !== 201) throw new Error(`expense create failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

async function uploadReceipt(
  app: ReturnType<typeof createApp>,
  expenseId: string,
  auth: Record<string, string>,
) {
  const fd = new FormData();
  fd.set(
    'file',
    new File([new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3])], 'r.jpg', { type: 'image/jpeg' }),
  );
  const res = await app.request(`/api/expenses/${expenseId}/receipt`, {
    method: 'POST',
    headers: auth,
    body: fd,
  });
  if (res.status !== 201) throw new Error(`receipt upload failed: ${res.status}`);
}

beforeEach(async () => {
  await resetDb();
  storageDir = await mkdtemp(join(tmpdir(), 'thalermark-extract-'));
  lastInput = null;
});
afterEach(async () => {
  await rm(storageDir, { recursive: true, force: true });
});

describe('receipt extraction', () => {
  it('extracts from an uploaded receipt and persists the result', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'ext@example.com');
      const { accountId, companyId } = await userContext('ext@example.com');
      const expenseId = await createExpense(ctx.app, cookie, accountId, companyId);
      const auth = { cookie, 'x-account-id': accountId };
      await uploadReceipt(ctx.app, expenseId, auth);

      const res = await ctx.app.request(`/api/expenses/${expenseId}/extract`, {
        method: 'POST',
        headers: auth,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        extractionStatus: string;
        extraction: ExtractionResult;
        suggestedCategoryAccountId: string | null;
      };
      expect(body.extractionStatus).toBe('succeeded');
      expect(body.extraction).toEqual(SAMPLE_RESULT);
      // Code 6000 resolved to its account id for the web prefill.
      expect(body.suggestedCategoryAccountId).toBe(await coaId(companyId, '6000'));

      // The route constrained the model to the company's expense COA.
      expect(lastInput?.mimeType).toBe('image/jpeg');
      expect(lastInput?.allowedCategories.some((c) => c.code === '6000')).toBe(true);

      // Persisted on the row.
      const db = getTestDb();
      const [row] = await db.select().from(expenses).where(eq(expenses.id, expenseId));
      expect(row?.extractionStatus).toBe('succeeded');
      expect(row?.extractionPayload).toEqual(SAMPLE_RESULT);
    } finally {
      await ctx.handle.close();
    }
  });

  it('503s when no extractor is configured', async () => {
    const ctx = buildApp({ extractor: null });
    try {
      const cookie = await signUp(ctx.app, 'ext-off@example.com');
      const { accountId, companyId } = await userContext('ext-off@example.com');
      const expenseId = await createExpense(ctx.app, cookie, accountId, companyId);
      const res = await ctx.app.request(`/api/expenses/${expenseId}/extract`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(res.status).toBe(503);
    } finally {
      await ctx.handle.close();
    }
  });

  it('400s when the expense has no receipt', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'ext-norcpt@example.com');
      const { accountId, companyId } = await userContext('ext-norcpt@example.com');
      const expenseId = await createExpense(ctx.app, cookie, accountId, companyId);
      const res = await ctx.app.request(`/api/expenses/${expenseId}/extract`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('no_receipt');
    } finally {
      await ctx.handle.close();
    }
  });

  it('commits extraction_status=failed and 502s when the model throws', async () => {
    const ctx = buildApp({ extractor: throwingExtractor });
    try {
      const cookie = await signUp(ctx.app, 'ext-fail@example.com');
      const { accountId, companyId } = await userContext('ext-fail@example.com');
      const expenseId = await createExpense(ctx.app, cookie, accountId, companyId);
      const auth = { cookie, 'x-account-id': accountId };
      await uploadReceipt(ctx.app, expenseId, auth);

      const res = await ctx.app.request(`/api/expenses/${expenseId}/extract`, {
        method: 'POST',
        headers: auth,
      });
      expect(res.status).toBe(502);

      // The failed status committed (the throw didn't roll it back).
      const db = getTestDb();
      const [row] = await db.select().from(expenses).where(eq(expenses.id, expenseId));
      expect(row?.extractionStatus).toBe('failed');
      expect(row?.extractionPayload).toBeNull();
    } finally {
      await ctx.handle.close();
    }
  });

  it('isolates extraction across accounts', async () => {
    const ctx = buildApp();
    try {
      const cookieA = await signUp(ctx.app, 'ext-a@example.com');
      const { accountId: accountA, companyId: companyA } = await userContext('ext-a@example.com');
      const expenseId = await createExpense(ctx.app, cookieA, accountA, companyA);
      await uploadReceipt(ctx.app, expenseId, { cookie: cookieA, 'x-account-id': accountA });

      const cookieB = await signUp(ctx.app, 'ext-b@example.com');
      const { accountId: accountB } = await userContext('ext-b@example.com');
      const res = await ctx.app.request(`/api/expenses/${expenseId}/extract`, {
        method: 'POST',
        headers: { cookie: cookieB, 'x-account-id': accountB },
      });
      expect(res.status).toBe(404);
    } finally {
      await ctx.handle.close();
    }
  });
});

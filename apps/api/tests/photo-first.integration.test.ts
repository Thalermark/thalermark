import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtractionInput, ExtractionResult, ReceiptExtractor } from '@thalermark/ai';
import { authUser, chartOfAccounts, companies, expenses, memberships } from '@thalermark/db';
import { type StorageProvider, createLocalFsProvider, readLocalObject } from '@thalermark/storage';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// TMC-295 — photo-first expense entry, the API half.
//
// POST /api/expenses/extract-receipt reads a receipt that belongs to nothing
// yet (multipart image + companyId) and persists NOTHING: no expense, no
// object, no status row. POST /api/expenses/with-receipt creates the expense
// AND attaches the photo in one call, both-or-neither: a storage failure must
// never leave an expense claiming a receipt it does not have.

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
  recurringSweepCron: '0 6 * * *',
};

const SAMPLE_RESULT: ExtractionResult = {
  merchant: 'Acme Tools',
  total: '19.99',
  expenseDate: '2026-05-02',
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
// bytes/mime/category set were passed through.
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

// A storage provider whose upload always fails — the with-receipt route's
// both-or-neither promise is only visible under exactly this fault.
function brokenStorage(): StorageProvider {
  const real = createLocalFsProvider({ baseDir: storageDir, secret: SECRET });
  return {
    ...real,
    name: real.name,
    putObject: async () => {
      throw new Error('storage unavailable');
    },
  };
}

function buildApp(
  opts: {
    extractor?: ReceiptExtractor;
    storage?: StorageProvider | null;
    ai?: boolean;
  } = {},
) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const handle = createApiDatabase(appDatabaseUrl());
  const auth = createApiAuth(getTestDb(), { ...testEnv, databaseUrl: url });
  const ai = opts.ai ?? true;
  const storage =
    opts.storage !== undefined
      ? opts.storage
      : createLocalFsProvider({ baseDir: storageDir, secret: SECRET });
  const app = createApp({
    auth,
    db: handle.db,
    bootstrapDb: getTestDb(),
    publicAppUrl: testEnv.publicAppUrl,
    storage,
    localFileServe: storage ? { secret: SECRET, baseDir: storageDir } : null,
    extractor: opts.extractor ?? okExtractor(),
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

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);

function receiptFile(type = 'image/jpeg', bytes: Uint8Array = JPEG_BYTES): File {
  return new File([new Uint8Array(bytes)], 'r.jpg', { type });
}

function extractForm(companyId?: string, file: File | null = receiptFile()): FormData {
  const fd = new FormData();
  if (file) fd.set('file', file);
  if (companyId) fd.set('companyId', companyId);
  return fd;
}

async function createForm(
  companyId: string,
  opts: { amount?: string; file?: File | null } = {},
): Promise<FormData> {
  const fd = new FormData();
  fd.set('companyId', companyId);
  fd.set('categoryAccountId', await coaId(companyId, '6000'));
  fd.set('paymentAccountId', await coaId(companyId, '1000'));
  fd.set('amount', opts.amount ?? '42.50');
  fd.set('expenseDate', '2026-05-20');
  fd.set('merchant', 'Home Depot');
  if (opts.file !== null) fd.set('file', opts.file ?? receiptFile());
  return fd;
}

async function expenseCount(accountId: string): Promise<number> {
  const rows = await getTestDb()
    .select({ id: expenses.id })
    .from(expenses)
    .where(eq(expenses.accountId, accountId));
  return rows.length;
}

beforeEach(async () => {
  await resetDb();
  storageDir = await mkdtemp(join(tmpdir(), 'thalermark-photo-first-'));
  lastInput = null;
});
afterEach(async () => {
  await rm(storageDir, { recursive: true, force: true });
});

describe('stateless receipt read (POST /api/expenses/extract-receipt)', () => {
  it('returns the suggestion for a receipt that belongs to nothing, and persists nothing', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'pf@example.com');
      const { accountId, companyId } = await userContext('pf@example.com');

      const res = await ctx.app.request('/api/expenses/extract-receipt', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
        body: extractForm(companyId),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        extractionStatus: string;
        extraction: ExtractionResult;
        suggestedCategoryAccountId: string | null;
      };
      expect(body.extractionStatus).toBe('succeeded');
      expect(body.extraction).toEqual(SAMPLE_RESULT);
      // Code 6000 resolved to its account id for the form prefill — the
      // sibling-of-extraction field mobile once dropped (TMC-295 footgun).
      expect(body.suggestedCategoryAccountId).toBe(await coaId(companyId, '6000'));

      // The route constrained the model to the company's expense COA and fed
      // it the uploaded bytes directly (no storage round-trip).
      expect(lastInput?.mimeType).toBe('image/jpeg');
      expect(new Uint8Array(lastInput?.bytes ?? [])).toEqual(JPEG_BYTES);
      expect(lastInput?.allowedCategories.some((c) => c.code === '6000')).toBe(true);
      expect(lastInput?.businessType).toBeNull();

      // Persists NOTHING: no expense row, no stored object. The expense is
      // created only on save — an abandoned photo must leave no ledger rows.
      expect(await expenseCount(accountId)).toBe(0);
      expect(await readdir(storageDir)).toEqual([]);
    } finally {
      await ctx.handle.close();
    }
  });

  it('502s when the model throws, still persisting nothing', async () => {
    const ctx = buildApp({ extractor: throwingExtractor });
    try {
      const cookie = await signUp(ctx.app, 'pf-fail@example.com');
      const { accountId, companyId } = await userContext('pf-fail@example.com');
      const res = await ctx.app.request('/api/expenses/extract-receipt', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
        body: extractForm(companyId),
      });
      expect(res.status).toBe(502);
      expect(((await res.json()) as { error: string }).error).toBe('extraction_failed');
      expect(await expenseCount(accountId)).toBe(0);
    } finally {
      await ctx.handle.close();
    }
  });

  it('503s when the account has no usable LLM credential', async () => {
    const ctx = buildApp({ ai: false });
    try {
      const cookie = await signUp(ctx.app, 'pf-off@example.com');
      const { accountId, companyId } = await userContext('pf-off@example.com');
      const res = await ctx.app.request('/api/expenses/extract-receipt', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
        body: extractForm(companyId),
      });
      expect(res.status).toBe(503);
    } finally {
      await ctx.handle.close();
    }
  });

  it('rejects a missing file, a bad mime type, a missing company, and a foreign company', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'pf-bad@example.com');
      const { accountId, companyId } = await userContext('pf-bad@example.com');
      const auth = { cookie, 'x-account-id': accountId };

      const noFile = await ctx.app.request('/api/expenses/extract-receipt', {
        method: 'POST',
        headers: auth,
        body: extractForm(companyId, null),
      });
      expect(noFile.status).toBe(400);
      expect(((await noFile.json()) as { error: string }).error).toBe('file_required');

      const gif = await ctx.app.request('/api/expenses/extract-receipt', {
        method: 'POST',
        headers: auth,
        body: extractForm(companyId, receiptFile('image/gif')),
      });
      expect(gif.status).toBe(415);

      const noCompany = await ctx.app.request('/api/expenses/extract-receipt', {
        method: 'POST',
        headers: auth,
        body: extractForm(undefined),
      });
      expect(noCompany.status).toBe(400);
      expect(((await noCompany.json()) as { error: string }).error).toBe('company_required');

      // Another account's company reads as absent, exactly like /categorize.
      await signUp(ctx.app, 'pf-other@example.com');
      const other = await userContext('pf-other@example.com');
      const foreign = await ctx.app.request('/api/expenses/extract-receipt', {
        method: 'POST',
        headers: auth,
        body: extractForm(other.companyId),
      });
      expect(foreign.status).toBe(404);
    } finally {
      await ctx.handle.close();
    }
  });
});

describe('one-call create with receipt (POST /api/expenses/with-receipt)', () => {
  it('creates the expense born with its photo attached', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'pfw@example.com');
      const { accountId, companyId } = await userContext('pfw@example.com');

      const res = await ctx.app.request('/api/expenses/with-receipt', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
        body: await createForm(companyId),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        id: string;
        receiptStorageKey: string;
        receiptUploadedAt: string;
        vendorReview: string | null;
        merchant: string;
        amount: string;
      };
      expect(body.merchant).toBe('Home Depot');
      expect(body.amount).toBe('42.50');
      // The key is scoped to the expense id the response carries: the row was
      // born attached, not attached after the fact.
      expect(body.receiptStorageKey).toMatch(
        new RegExp(`^accounts/${accountId}/companies/${companyId}/expenses/${body.id}/.+\\.jpg$`),
      );
      expect(body.receiptUploadedAt).toBeTruthy();
      // Scan-and-forget: a receipt on a vendor-less expense queues for review,
      // same rule as the two-step attach flow.
      expect(body.vendorReview).toBe('needs_review');

      // Row and object both exist — the "both" half of both-or-neither.
      const [row] = await getTestDb().select().from(expenses).where(eq(expenses.id, body.id));
      expect(row?.receiptStorageKey).toBe(body.receiptStorageKey);
      const onDisk = await readLocalObject(storageDir, body.receiptStorageKey);
      expect(new Uint8Array(onDisk)).toEqual(JPEG_BYTES);
    } finally {
      await ctx.handle.close();
    }
  });

  it('creates NO expense when the storage write fails (both-or-neither)', async () => {
    const ctx = buildApp({ storage: brokenStorage() });
    try {
      const cookie = await signUp(ctx.app, 'pfw-fail@example.com');
      const { accountId, companyId } = await userContext('pfw-fail@example.com');

      const res = await ctx.app.request('/api/expenses/with-receipt', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
        body: await createForm(companyId),
      });
      expect(res.status).toBe(500);
      // The insert + audit + posting all rolled back with the failed upload:
      // no expense claiming a receipt that is not there.
      expect(await expenseCount(accountId)).toBe(0);
    } finally {
      await ctx.handle.close();
    }
  });

  it('rejects invalid fields, a missing file, and a foreign company without creating anything', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'pfw-bad@example.com');
      const { accountId, companyId } = await userContext('pfw-bad@example.com');
      const auth = { cookie, 'x-account-id': accountId };

      const badAmount = await ctx.app.request('/api/expenses/with-receipt', {
        method: 'POST',
        headers: auth,
        body: await createForm(companyId, { amount: 'not-money' }),
      });
      expect(badAmount.status).toBe(400);
      expect(((await badAmount.json()) as { error: string }).error).toBe('invalid_body');

      const noFile = await ctx.app.request('/api/expenses/with-receipt', {
        method: 'POST',
        headers: auth,
        body: await createForm(companyId, { file: null }),
      });
      expect(noFile.status).toBe(400);
      expect(((await noFile.json()) as { error: string }).error).toBe('file_required');

      await signUp(ctx.app, 'pfw-other@example.com');
      const other = await userContext('pfw-other@example.com');
      const foreignForm = await createForm(other.companyId);
      const foreign = await ctx.app.request('/api/expenses/with-receipt', {
        method: 'POST',
        headers: auth,
        body: foreignForm,
      });
      expect(foreign.status).toBe(404);

      expect(await expenseCount(accountId)).toBe(0);
      expect(await expenseCount(other.accountId)).toBe(0);
      // Nothing hit storage either: the object write is the last step, so a
      // refused create uploads no garbage.
      expect(await readdir(storageDir)).toEqual([]);
    } finally {
      await ctx.handle.close();
    }
  });

  it('503s when storage is not configured', async () => {
    const ctx = buildApp({ storage: null });
    try {
      const cookie = await signUp(ctx.app, 'pfw-nostore@example.com');
      const { accountId, companyId } = await userContext('pfw-nostore@example.com');
      const res = await ctx.app.request('/api/expenses/with-receipt', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
        body: await createForm(companyId),
      });
      expect(res.status).toBe(503);
    } finally {
      await ctx.handle.close();
    }
  });
});

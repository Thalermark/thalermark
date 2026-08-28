import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authUser, chartOfAccounts, companies, expenses, memberships } from '@thalermark/db';
import { createLocalFsProvider, readLocalObject } from '@thalermark/storage';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// 8.9g — receipt capture. Exercises the upload → signed-URL → /api/files serve
// → delete chain against the local-FS storage adapter, plus validation and
// tenant isolation.

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

function extractSessionCookie(res: Response): string {
  const list =
    (res.headers as { getSetCookie?: () => string[] }).getSetCookie?.() ??
    [res.headers.get('set-cookie') ?? ''].filter(Boolean);
  return list.map((c) => c.split(';')[0]).join('; ');
}

let storageDir: string;

function buildApp(opts: { withStorage?: boolean } = { withStorage: true }) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const handle = createApiDatabase(appDatabaseUrl());
  const auth = createApiAuth(getTestDb(), { ...testEnv, databaseUrl: url });
  const storage = opts.withStorage
    ? createLocalFsProvider({ baseDir: storageDir, secret: SECRET })
    : null;
  const app = createApp({
    auth,
    db: handle.db,
    bootstrapDb: getTestDb(),
    publicAppUrl: testEnv.publicAppUrl,
    storage,
    localFileServe: opts.withStorage ? { secret: SECRET, baseDir: storageDir } : null,
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

function uploadForm(bytes: Uint8Array, type: string, name = 'receipt'): FormData {
  const fd = new FormData();
  // Copy into a fresh ArrayBuffer-backed Uint8Array so it satisfies BlobPart
  // (TextEncoder/Buffer can hand back Uint8Array<ArrayBufferLike>).
  fd.set('file', new File([new Uint8Array(bytes)], name, { type }));
  return fd;
}

beforeEach(async () => {
  await resetDb();
  storageDir = await mkdtemp(join(tmpdir(), 'thalermark-receipts-'));
});
afterEach(async () => {
  await rm(storageDir, { recursive: true, force: true });
});

describe('receipt capture', () => {
  it('uploads, serves via signed URL, and deletes a receipt', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'rcpt@example.com');
      const { accountId, companyId } = await userContext('rcpt@example.com');
      const expenseId = await createExpense(ctx.app, cookie, accountId, companyId);
      const auth = { cookie, 'x-account-id': accountId };

      const bytes = new TextEncoder().encode('\xFF\xD8\xFFfake-jpeg-bytes');
      const up = await ctx.app.request(`/api/expenses/${expenseId}/receipt`, {
        method: 'POST',
        headers: auth,
        body: uploadForm(bytes, 'image/jpeg'),
      });
      expect(up.status).toBe(201);
      const upBody = (await up.json()) as { receiptStorageKey: string };
      expect(upBody.receiptStorageKey).toMatch(
        new RegExp(`^accounts/${accountId}/companies/${companyId}/expenses/${expenseId}/`),
      );

      // Column set + object on disk.
      const db = getTestDb();
      const [row] = await db.select().from(expenses).where(eq(expenses.id, expenseId));
      expect(row?.receiptStorageKey).toBe(upBody.receiptStorageKey);
      expect(row?.receiptUploadedAt).not.toBeNull();
      // Scan-and-forget: a receipt on a vendor-less expense queues for review.
      expect(row?.vendorReview).toBe('needs_review');
      const onDisk = await readLocalObject(storageDir, upBody.receiptStorageKey);
      expect(new Uint8Array(onDisk)).toEqual(bytes);

      // Signed URL.
      const getUrl = await ctx.app.request(`/api/expenses/${expenseId}/receipt`, { headers: auth });
      expect(getUrl.status).toBe(200);
      const { url, contentType } = (await getUrl.json()) as { url: string; contentType: string };
      expect(contentType).toBe('image/jpeg');
      expect(url.startsWith('/api/files/')).toBe(true);

      // Serve route returns the bytes (public path, no auth headers).
      const served = await ctx.app.request(url);
      expect(served.status).toBe(200);
      expect(served.headers.get('content-type')).toBe('image/jpeg');
      expect(served.headers.get('x-content-type-options')).toBe('nosniff');
      // Images stay inline — company logos render via <img> from this route.
      expect(served.headers.get('content-disposition')).toBeNull();
      expect(new Uint8Array(await served.arrayBuffer())).toEqual(bytes);

      // Delete nulls the columns + removes the object.
      const del = await ctx.app.request(`/api/expenses/${expenseId}/receipt`, {
        method: 'DELETE',
        headers: auth,
      });
      expect(del.status).toBe(200);
      const [after] = await db.select().from(expenses).where(eq(expenses.id, expenseId));
      expect(after?.receiptStorageKey).toBeNull();
      expect(after?.receiptUploadedAt).toBeNull();
      await expect(stat(join(storageDir, upBody.receiptStorageKey))).rejects.toThrow();
    } finally {
      await ctx.handle.close();
    }
  });

  it('rejects an unsupported media type and an oversized file', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'rcpt-bad@example.com');
      const { accountId, companyId } = await userContext('rcpt-bad@example.com');
      const expenseId = await createExpense(ctx.app, cookie, accountId, companyId);
      const auth = { cookie, 'x-account-id': accountId };

      const gif = await ctx.app.request(`/api/expenses/${expenseId}/receipt`, {
        method: 'POST',
        headers: auth,
        body: uploadForm(new Uint8Array([1, 2, 3]), 'image/gif'),
      });
      expect(gif.status).toBe(415);

      const tooBig = new Uint8Array(10 * 1024 * 1024 + 1);
      const big = await ctx.app.request(`/api/expenses/${expenseId}/receipt`, {
        method: 'POST',
        headers: auth,
        body: uploadForm(tooBig, 'application/pdf'),
      });
      expect(big.status).toBe(413);
    } finally {
      await ctx.handle.close();
    }
  });

  it('503s when storage is not configured', async () => {
    const ctx = buildApp({ withStorage: false });
    try {
      const cookie = await signUp(ctx.app, 'rcpt-nostore@example.com');
      const { accountId, companyId } = await userContext('rcpt-nostore@example.com');
      const expenseId = await createExpense(ctx.app, cookie, accountId, companyId);
      const res = await ctx.app.request(`/api/expenses/${expenseId}/receipt`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
        body: uploadForm(new Uint8Array([1]), 'image/png'),
      });
      expect(res.status).toBe(503);
    } finally {
      await ctx.handle.close();
    }
  });

  it('rejects a tampered/garbage file token with 403', async () => {
    const ctx = buildApp();
    try {
      const res = await ctx.app.request('/api/files/not-a-real-token');
      expect(res.status).toBe(403);
    } finally {
      await ctx.handle.close();
    }
  });

  it('serves a PDF receipt as an attachment, not inline', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'rcpt-pdf@example.com');
      const { accountId, companyId } = await userContext('rcpt-pdf@example.com');
      const expenseId = await createExpense(ctx.app, cookie, accountId, companyId);
      const auth = { cookie, 'x-account-id': accountId };

      const bytes = new TextEncoder().encode('%PDF-1.4 fake-pdf-bytes');
      const up = await ctx.app.request(`/api/expenses/${expenseId}/receipt`, {
        method: 'POST',
        headers: auth,
        body: uploadForm(bytes, 'application/pdf', 'receipt.pdf'),
      });
      expect(up.status).toBe(201);

      const getUrl = await ctx.app.request(`/api/expenses/${expenseId}/receipt`, { headers: auth });
      const { url } = (await getUrl.json()) as { url: string };
      const served = await ctx.app.request(url);
      expect(served.status).toBe(200);
      expect(served.headers.get('content-type')).toBe('application/pdf');
      expect(served.headers.get('x-content-type-options')).toBe('nosniff');
      // An inline same-origin PDF is the phishing surface we're closing.
      expect(served.headers.get('content-disposition')).toBe('attachment');
    } finally {
      await ctx.handle.close();
    }
  });

  // TMC-267: the app holds the only copy of a photographed receipt, so the detail
  // page carries a Download button. It needs a SECOND url over the same object,
  // because the preview <img> needs the inline one; that is the pairing worth
  // pinning, along with the fact that the filename is signed rather than
  // attacker-chosen.
  it('returns a second, download-flavoured URL for an image receipt', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'rcpt-dl@example.com');
      const { accountId, companyId } = await userContext('rcpt-dl@example.com');
      const expenseId = await createExpense(ctx.app, cookie, accountId, companyId);
      const auth = { cookie, 'x-account-id': accountId };

      const bytes = new TextEncoder().encode('jpeg-bytes');
      const up = await ctx.app.request(`/api/expenses/${expenseId}/receipt`, {
        method: 'POST',
        headers: auth,
        body: uploadForm(bytes, 'image/jpeg', 'receipt.jpg'),
      });
      expect(up.status).toBe(201);

      const getUrl = await ctx.app.request(`/api/expenses/${expenseId}/receipt`, { headers: auth });
      const { url, downloadUrl } = (await getUrl.json()) as { url: string; downloadUrl: string };
      expect(downloadUrl).toBeTruthy();
      expect(downloadUrl).not.toBe(url);

      // The preview URL must stay inline — an <img> renders from it, and the
      // company-logo route shares this code path.
      const inline = await ctx.app.request(url);
      expect(inline.status).toBe(200);
      expect(inline.headers.get('content-type')).toBe('image/jpeg');
      expect(inline.headers.get('content-disposition')).toBeNull();

      // The download URL saves, under a name built from the expense.
      const saved = await ctx.app.request(downloadUrl);
      expect(saved.status).toBe(200);
      expect(saved.headers.get('content-type')).toBe('image/jpeg');
      expect(saved.headers.get('content-disposition')).toBe(
        'attachment; filename="receipt-home-depot-2026-05-20.jpg"',
      );
    } finally {
      await ctx.handle.close();
    }
  });

  it('isolates receipts across accounts', async () => {
    const ctx = buildApp();
    try {
      const cookieA = await signUp(ctx.app, 'rcpt-a@example.com');
      const { accountId: accountA, companyId: companyA } = await userContext('rcpt-a@example.com');
      const expenseId = await createExpense(ctx.app, cookieA, accountA, companyA);
      const up = await ctx.app.request(`/api/expenses/${expenseId}/receipt`, {
        method: 'POST',
        headers: { cookie: cookieA, 'x-account-id': accountA },
        body: uploadForm(new Uint8Array([1, 2, 3]), 'image/png'),
      });
      expect(up.status).toBe(201);

      const cookieB = await signUp(ctx.app, 'rcpt-b@example.com');
      const { accountId: accountB } = await userContext('rcpt-b@example.com');

      const getB = await ctx.app.request(`/api/expenses/${expenseId}/receipt`, {
        headers: { cookie: cookieB, 'x-account-id': accountB },
      });
      expect(getB.status).toBe(404);

      const delB = await ctx.app.request(`/api/expenses/${expenseId}/receipt`, {
        method: 'DELETE',
        headers: { cookie: cookieB, 'x-account-id': accountB },
      });
      expect(delB.status).toBe(404);
    } finally {
      await ctx.handle.close();
    }
  });
});

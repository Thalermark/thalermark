import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authUser, companies, memberships } from '@thalermark/db';
import { createLocalFsProvider, readLocalObject } from '@thalermark/storage';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { getTestDb, resetDb } from './test-helper.js';

// Company logo — exercises the upload → signed-URL → /api/files serve → delete
// chain against the local-FS adapter, plus the media-type guard. Mirrors the
// receipt-capture test; storage and auth wiring are identical.

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

function buildApp() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const handle = createApiDatabase(url);
  const auth = createApiAuth(handle.db, { ...testEnv, databaseUrl: url });
  const storage = createLocalFsProvider({ baseDir: storageDir, secret: SECRET });
  const app = createApp({
    auth,
    db: handle.db,
    publicAppUrl: testEnv.publicAppUrl,
    storage,
    localFileServe: { secret: SECRET, baseDir: storageDir },
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

function uploadForm(bytes: Uint8Array, type: string, name = 'logo'): FormData {
  const fd = new FormData();
  fd.set('file', new File([new Uint8Array(bytes)], name, { type }));
  return fd;
}

beforeEach(async () => {
  await resetDb();
  storageDir = await mkdtemp(join(tmpdir(), 'thalermark-logo-'));
});
afterEach(async () => {
  await rm(storageDir, { recursive: true, force: true });
});

describe('company logo', () => {
  it('uploads, serves via signed URL, and removes a logo', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'logo@example.com');
      const { accountId, companyId } = await userContext('logo@example.com');
      const auth = { cookie, 'x-account-id': accountId };

      const bytes = new TextEncoder().encode('\x89PNGfake-png-bytes');
      const up = await ctx.app.request(`/api/companies/${companyId}/logo`, {
        method: 'POST',
        headers: auth,
        body: uploadForm(bytes, 'image/png'),
      });
      expect(up.status).toBe(201);
      const upBody = (await up.json()) as { logoStorageKey: string };
      expect(upBody.logoStorageKey).toMatch(
        new RegExp(`^accounts/${accountId}/companies/${companyId}/branding/`),
      );

      // Column set + object on disk.
      const db = getTestDb();
      const [row] = await db.select().from(companies).where(eq(companies.id, companyId));
      expect(row?.logoStorageKey).toBe(upBody.logoStorageKey);
      const onDisk = await readLocalObject(storageDir, upBody.logoStorageKey);
      expect(new Uint8Array(onDisk)).toEqual(bytes);

      // Signed URL + public serve (no auth headers).
      const getUrl = await ctx.app.request(`/api/companies/${companyId}/logo`, { headers: auth });
      expect(getUrl.status).toBe(200);
      const { url, contentType } = (await getUrl.json()) as { url: string; contentType: string };
      expect(contentType).toBe('image/png');
      const served = await ctx.app.request(url);
      expect(served.status).toBe(200);
      expect(new Uint8Array(await served.arrayBuffer())).toEqual(bytes);

      // Remove nulls the column + drops the object.
      const del = await ctx.app.request(`/api/companies/${companyId}/logo`, {
        method: 'DELETE',
        headers: auth,
      });
      expect(del.status).toBe(200);
      const [after] = await db.select().from(companies).where(eq(companies.id, companyId));
      expect(after?.logoStorageKey).toBeNull();
      await expect(stat(join(storageDir, upBody.logoStorageKey))).rejects.toThrow();
    } finally {
      await ctx.handle.close();
    }
  });

  it('rejects an unsupported media type', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'logo-bad@example.com');
      const { accountId, companyId } = await userContext('logo-bad@example.com');
      const auth = { cookie, 'x-account-id': accountId };

      const res = await ctx.app.request(`/api/companies/${companyId}/logo`, {
        method: 'POST',
        headers: auth,
        body: uploadForm(new TextEncoder().encode('%PDF-1.4'), 'application/pdf'),
      });
      expect(res.status).toBe(415);
    } finally {
      await ctx.handle.close();
    }
  });
});

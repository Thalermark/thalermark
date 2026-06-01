import { authUser, companies, memberships } from '@thalermark/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { getTestDb, resetDb } from './test-helper.js';

// 8.9d — GET /api/companies/:id/accounts. Reads the company's chart of
// accounts (active rows, ordered by code), optionally narrowed by type. Powers
// the expense category/payment comboboxes (8.9e) and the list category filter.

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

function extractSessionCookie(res: Response): string {
  const list =
    (res.headers as { getSetCookie?: () => string[] }).getSetCookie?.() ??
    [res.headers.get('set-cookie') ?? ''].filter(Boolean);
  return list.map((c) => c.split(';')[0]).join('; ');
}

function buildApp() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const handle = createApiDatabase(url);
  const auth = createApiAuth(handle.db, { ...testEnv, databaseUrl: url });
  const app = createApp({ auth, db: handle.db, publicAppUrl: testEnv.publicAppUrl });
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

type Account = { id: string; code: string; name: string; accountType: string };

describe('GET /api/companies/:id/accounts', () => {
  beforeEach(resetDb);

  it('returns the seeded chart of accounts ordered by code', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'acc-all@example.com');
      const { accountId, companyId } = await userContext('acc-all@example.com');
      const res = await ctx.app.request(`/api/companies/${companyId}/accounts`, {
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(res.status).toBe(200);
      const { accounts } = (await res.json()) as { accounts: Account[] };
      // Sole-prop seed is 26 accounts; first is Cash (1000), and the codes
      // come back sorted ascending.
      expect(accounts.length).toBeGreaterThan(0);
      expect(accounts[0]).toMatchObject({ code: '1000', accountType: 'asset' });
      const codes = accounts.map((a) => a.code);
      expect([...codes].sort()).toEqual(codes);
    } finally {
      await ctx.handle.close();
    }
  });

  it('narrows to a single account_type via ?type=', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'acc-type@example.com');
      const { accountId, companyId } = await userContext('acc-type@example.com');
      const res = await ctx.app.request(`/api/companies/${companyId}/accounts?type=expense`, {
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(res.status).toBe(200);
      const { accounts } = (await res.json()) as { accounts: Account[] };
      expect(accounts.length).toBeGreaterThan(0);
      expect(accounts.every((a) => a.accountType === 'expense')).toBe(true);
      // The expense block is the Schedule C 6000–7950 range.
      expect(accounts.every((a) => a.code >= '6000')).toBe(true);

      // An unknown type returns an empty set rather than erroring.
      const none = await ctx.app.request(`/api/companies/${companyId}/accounts?type=nope`, {
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(none.status).toBe(200);
      expect(((await none.json()) as { accounts: Account[] }).accounts).toEqual([]);
    } finally {
      await ctx.handle.close();
    }
  });

  it('404s on a company the caller does not own', async () => {
    const ctx = buildApp();
    try {
      await signUp(ctx.app, 'acc-a@example.com');
      const { companyId: companyA } = await userContext('acc-a@example.com');

      const cookieB = await signUp(ctx.app, 'acc-b@example.com');
      const { accountId: accountB } = await userContext('acc-b@example.com');

      const res = await ctx.app.request(`/api/companies/${companyA}/accounts`, {
        headers: { cookie: cookieB, 'x-account-id': accountB },
      });
      expect(res.status).toBe(404);
      expect((await res.json()) as { error: string }).toMatchObject({ error: 'company_not_found' });
    } finally {
      await ctx.handle.close();
    }
  });
});

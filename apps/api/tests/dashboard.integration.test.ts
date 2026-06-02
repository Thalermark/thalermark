import { authUser, chartOfAccounts, companies, memberships } from '@thalermark/db';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { getTestDb, resetDb } from './test-helper.js';

// 8.10 — position dashboard. Asserts money-in / money-out / owed read off the
// ledger across a full invoice + expense lifecycle, the date window, empty
// state, tenant isolation, and query validation. Cash = asset accounts other
// than AR; owed = the AR balance.

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

async function coaId(companyId: string, code: string): Promise<string> {
  const db = getTestDb();
  const [row] = await db
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.companyId, companyId), eq(chartOfAccounts.code, code)));
  if (!row) throw new Error(`COA ${code} not seeded`);
  return row.id;
}

async function createCustomer(
  app: ReturnType<typeof createApp>,
  cookie: string,
  accountId: string,
  companyId: string,
): Promise<string> {
  const res = await app.request('/api/customers', {
    method: 'POST',
    headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
    body: JSON.stringify({ companyId, name: 'Wile E. Coyote' }),
  });
  if (res.status !== 201) throw new Error(`customer create failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

async function createInvoice(
  app: ReturnType<typeof createApp>,
  cookie: string,
  accountId: string,
  companyId: string,
  customerId: string,
  number: string,
): Promise<string> {
  // Untaxed, total 100, so the cash/AR math is round.
  const res = await app.request('/api/invoices', {
    method: 'POST',
    headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
    body: JSON.stringify({
      companyId,
      customerId,
      number,
      issueDate: '2026-06-01',
      dueDate: '2026-07-01',
      subtotal: '100.00',
      tax: '0',
      total: '100.00',
      lineItems: [
        {
          position: 1,
          description: 'Service',
          quantity: '1',
          unitPrice: '100.00',
          amount: '100.00',
        },
      ],
    }),
  });
  if (res.status !== 201) throw new Error(`invoice create failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

async function transition(
  app: ReturnType<typeof createApp>,
  cookie: string,
  accountId: string,
  invoiceId: string,
  action: 'mark-sent' | 'mark-paid',
) {
  const res = await app.request(`/api/invoices/${invoiceId}/${action}`, {
    method: 'POST',
    headers: { cookie, 'x-account-id': accountId },
  });
  if (res.status !== 200) throw new Error(`${action} failed: ${res.status}`);
}

async function createExpense(
  app: ReturnType<typeof createApp>,
  cookie: string,
  accountId: string,
  companyId: string,
  amount: string,
  expenseDate: string,
) {
  const res = await app.request('/api/expenses', {
    method: 'POST',
    headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
    body: JSON.stringify({
      companyId,
      categoryAccountId: await coaId(companyId, '6000'),
      paymentAccountId: await coaId(companyId, '1000'),
      amount,
      expenseDate,
      merchant: 'Fuel',
    }),
  });
  if (res.status !== 201) throw new Error(`expense create failed: ${res.status}`);
}

type Dashboard = { moneyIn: string; moneyOut: string; owed: string; from: string; to: string };

async function dashboard(
  app: ReturnType<typeof createApp>,
  cookie: string,
  accountId: string,
  companyId: string,
  query = '',
): Promise<Response> {
  return app.request(`/api/companies/${companyId}/dashboard${query}`, {
    headers: { cookie, 'x-account-id': accountId },
  });
}

const YEAR = '?from=2026-01-01&to=2026-12-31';

beforeEach(resetDb);

describe('position dashboard', () => {
  it('reports money in / out / owed across an invoice + expense lifecycle', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'dash@example.com');
      const { accountId, companyId } = await userContext('dash@example.com');
      const customerId = await createCustomer(ctx.app, cookie, accountId, companyId);

      // Invoice A: sent then paid → Cash +100 (money in), AR nets to 0.
      const a = await createInvoice(ctx.app, cookie, accountId, companyId, customerId, 'INV-0001');
      await transition(ctx.app, cookie, accountId, a, 'mark-sent');
      await transition(ctx.app, cookie, accountId, a, 'mark-paid');

      // Invoice B: sent, unpaid → AR +100 (owed).
      const b = await createInvoice(ctx.app, cookie, accountId, companyId, customerId, 'INV-0002');
      await transition(ctx.app, cookie, accountId, b, 'mark-sent');

      // Expense: Cr Cash 40 (money out).
      await createExpense(ctx.app, cookie, accountId, companyId, '40.00', '2026-06-01');

      const res = await dashboard(ctx.app, cookie, accountId, companyId, YEAR);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Dashboard;
      expect(body.moneyIn).toBe('100.00');
      expect(body.moneyOut).toBe('40.00');
      expect(body.owed).toBe('100.00');
    } finally {
      await ctx.handle.close();
    }
  });

  it('windows money in/out by date but reports owed point-in-time', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'dash-win@example.com');
      const { accountId, companyId } = await userContext('dash-win@example.com');
      await createExpense(ctx.app, cookie, accountId, companyId, '40.00', '2026-03-15');

      const inWindow = (await (
        await dashboard(ctx.app, cookie, accountId, companyId, '?from=2026-03-01&to=2026-03-31')
      ).json()) as Dashboard;
      expect(inWindow.moneyOut).toBe('40.00');

      const outOfWindow = (await (
        await dashboard(ctx.app, cookie, accountId, companyId, '?from=2026-04-01&to=2026-04-30')
      ).json()) as Dashboard;
      expect(outOfWindow.moneyOut).toBe('0.00');
    } finally {
      await ctx.handle.close();
    }
  });

  it('returns zeros for a company with no activity', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'dash-empty@example.com');
      const { accountId, companyId } = await userContext('dash-empty@example.com');
      const body = (await (
        await dashboard(ctx.app, cookie, accountId, companyId, YEAR)
      ).json()) as Dashboard;
      expect(body).toMatchObject({ moneyIn: '0.00', moneyOut: '0.00', owed: '0.00' });
    } finally {
      await ctx.handle.close();
    }
  });

  it("404s on another account's company", async () => {
    const ctx = buildApp();
    try {
      await signUp(ctx.app, 'dash-a@example.com');
      const { companyId: companyA } = await userContext('dash-a@example.com');
      const cookieB = await signUp(ctx.app, 'dash-b@example.com');
      const { accountId: accountB } = await userContext('dash-b@example.com');

      const res = await dashboard(ctx.app, cookieB, accountB, companyA, YEAR);
      expect(res.status).toBe(404);
    } finally {
      await ctx.handle.close();
    }
  });

  it('400s on an unknown period and a flipped range', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'dash-bad@example.com');
      const { accountId, companyId } = await userContext('dash-bad@example.com');
      const badPeriod = await dashboard(ctx.app, cookie, accountId, companyId, '?period=decade');
      expect(badPeriod.status).toBe(400);
      const flipped = await dashboard(
        ctx.app,
        cookie,
        accountId,
        companyId,
        '?from=2026-12-31&to=2026-01-01',
      );
      expect(flipped.status).toBe(400);
    } finally {
      await ctx.handle.close();
    }
  });
});

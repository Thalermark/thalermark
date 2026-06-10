import { authUser, chartOfAccounts, companies, memberships } from '@thalermark/db';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { getTestDb, resetDb } from './test-helper.js';

// Profit & Loss report (the tax set). Accrual income statement off the GL:
// revenue recognized at mark-sent, expenses at create. Asserts the per-account
// nets, reversal-safety (a voided sale nets to zero and is dropped), the date
// window, and tax-mapping passthrough.

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

async function signUp(app: ReturnType<typeof createApp>, email: string) {
  const res = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct horse battery staple', name: email }),
  });
  if (res.status !== 200) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  return extractSessionCookie(res);
}

async function userContext(email: string): Promise<{ accountId: string; companyId: string }> {
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
  if (!company) throw new Error(`default company for ${email} not seeded`);
  return { accountId: m.accountId, companyId: company.id };
}

function buildApp() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const handle = createApiDatabase(url);
  const auth = createApiAuth(handle.db, { ...testEnv, databaseUrl: url });
  const app = createApp({ auth, db: handle.db, publicAppUrl: testEnv.publicAppUrl });
  return { app, handle };
}

type Ctx = {
  app: ReturnType<typeof createApp>;
  cookie: string;
  accountId: string;
  companyId: string;
};

async function setup(email: string): Promise<{ ctx: Ctx; close: () => Promise<void> }> {
  const { app, handle } = buildApp();
  const cookie = await signUp(app, email);
  const { accountId, companyId } = await userContext(email);
  return { ctx: { app, cookie, accountId, companyId }, close: handle.close };
}

function headers(ctx: Ctx) {
  return { cookie: ctx.cookie, 'x-account-id': ctx.accountId, 'content-type': 'application/json' };
}

async function coaId(companyId: string, code: string): Promise<string> {
  const db = getTestDb();
  const [row] = await db
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.companyId, companyId), eq(chartOfAccounts.code, code)));
  if (!row) throw new Error(`COA ${code} not seeded for company ${companyId}`);
  return row.id;
}

async function createCustomer(ctx: Ctx): Promise<string> {
  const res = await ctx.app.request('/api/customers', {
    method: 'POST',
    headers: headers(ctx),
    body: JSON.stringify({ companyId: ctx.companyId, name: 'Acme' }),
  });
  if (res.status !== 201) throw new Error(`customer create failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

async function createInvoice(
  ctx: Ctx,
  customerId: string,
  opts: { number: string; subtotal: string; tax: string; total: string },
): Promise<string> {
  const res = await ctx.app.request('/api/invoices', {
    method: 'POST',
    headers: headers(ctx),
    body: JSON.stringify({
      companyId: ctx.companyId,
      customerId,
      number: opts.number,
      issueDate: '2026-05-23',
      dueDate: '2026-06-22',
      subtotal: opts.subtotal,
      tax: opts.tax,
      total: opts.total,
      lineItems: [
        {
          position: 1,
          description: 'Service',
          quantity: '1',
          unitPrice: opts.subtotal,
          amount: opts.subtotal,
        },
      ],
    }),
  });
  if (res.status !== 201)
    throw new Error(`invoice create failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

async function post(ctx: Ctx, path: string, body?: unknown): Promise<void> {
  const res = await ctx.app.request(path, {
    method: 'POST',
    headers: headers(ctx),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status !== 200) throw new Error(`POST ${path} failed: ${res.status} ${await res.text()}`);
}

async function createExpense(
  ctx: Ctx,
  opts: { categoryCode: string; amount: string; expenseDate: string },
): Promise<void> {
  const categoryAccountId = await coaId(ctx.companyId, opts.categoryCode);
  const paymentAccountId = await coaId(ctx.companyId, '1000'); // Cash
  const res = await ctx.app.request('/api/expenses', {
    method: 'POST',
    headers: headers(ctx),
    body: JSON.stringify({
      companyId: ctx.companyId,
      categoryAccountId,
      paymentAccountId,
      amount: opts.amount,
      expenseDate: opts.expenseDate,
      merchant: 'Vendor',
    }),
  });
  if (res.status !== 201)
    throw new Error(`expense create failed: ${res.status} ${await res.text()}`);
}

type PL = {
  from: string;
  to: string;
  revenue: { code: string; name: string; taxMapping: string | null; amount: string }[];
  expenses: { code: string; name: string; taxMapping: string | null; amount: string }[];
  totalRevenue: string;
  totalExpenses: string;
  netProfit: string;
};

async function getPL(ctx: Ctx, query = ''): Promise<{ status: number; body: PL }> {
  const res = await ctx.app.request(`/api/companies/${ctx.companyId}/profit-loss${query}`, {
    headers: headers(ctx),
  });
  return { status: res.status, body: (await res.json()) as PL };
}

describe('GET /api/companies/:id/profit-loss', () => {
  beforeEach(resetDb);

  it('computes accrual revenue, expenses by category, and net profit', async () => {
    const { ctx, close } = await setup('pl@example.com');
    try {
      const today = new Date().toISOString().slice(0, 10);
      const cust = await createCustomer(ctx);

      // A: sent only → Service Revenue 100 (tax 8.25 goes to a liability, not P&L).
      const a = await createInvoice(ctx, cust, {
        number: 'A',
        subtotal: '100.00',
        tax: '8.25',
        total: '108.25',
      });
      await post(ctx, `/api/invoices/${a}/mark-sent`);
      // B: sent then paid → Revenue 200 booked once at sent; paid only moves AR→Cash.
      const b = await createInvoice(ctx, cust, {
        number: 'B',
        subtotal: '200.00',
        tax: '0.00',
        total: '200.00',
      });
      await post(ctx, `/api/invoices/${b}/mark-sent`);
      await post(ctx, `/api/invoices/${b}/mark-paid`, { method: 'cash' });
      // C: sent then voided → Revenue 50 then −50 nets to zero, dropped.
      const cInv = await createInvoice(ctx, cust, {
        number: 'C',
        subtotal: '50.00',
        tax: '0.00',
        total: '50.00',
      });
      await post(ctx, `/api/invoices/${cInv}/mark-sent`);
      await post(ctx, `/api/invoices/${cInv}/void`);

      // Expenses in two Schedule C categories.
      await createExpense(ctx, { categoryCode: '6100', amount: '30.00', expenseDate: today }); // Car & Truck
      await createExpense(ctx, { categoryCode: '6400', amount: '20.00', expenseDate: today }); // Insurance

      const { status, body } = await getPL(ctx);
      expect(status).toBe(200);

      // Revenue: a single Service Revenue (4000) line of 300, voided sale excluded.
      expect(body.revenue).toHaveLength(1);
      expect(body.revenue[0]?.code).toBe('4000');
      expect(body.revenue[0]?.amount).toBe('300.00');
      expect(body.revenue[0]?.taxMapping).toBe('Schedule C, Line 1');
      expect(body.totalRevenue).toBe('300.00');

      // Expenses: two category lines, sorted by code.
      expect(body.expenses.map((e) => [e.code, e.amount])).toEqual([
        ['6100', '30.00'],
        ['6400', '20.00'],
      ]);
      expect(body.totalExpenses).toBe('50.00');
      expect(body.netProfit).toBe('250.00');
    } finally {
      await close();
    }
  });

  it('honors the date window — a past range excludes current activity', async () => {
    const { ctx, close } = await setup('pl-window@example.com');
    try {
      const cust = await createCustomer(ctx);
      const a = await createInvoice(ctx, cust, {
        number: 'A',
        subtotal: '100.00',
        tax: '0.00',
        total: '100.00',
      });
      await post(ctx, `/api/invoices/${a}/mark-sent`);

      const { status, body } = await getPL(ctx, '?from=2020-01-01&to=2020-12-31');
      expect(status).toBe(200);
      expect(body.revenue).toEqual([]);
      expect(body.expenses).toEqual([]);
      expect(body.totalRevenue).toBe('0.00');
      expect(body.netProfit).toBe('0.00');
      expect(body.from).toBe('2020-01-01');
      expect(body.to).toBe('2020-12-31');
    } finally {
      await close();
    }
  });

  it('400s a malformed from and a flipped range', async () => {
    const { ctx, close } = await setup('pl-bad@example.com');
    try {
      const bad = await ctx.app.request(`/api/companies/${ctx.companyId}/profit-loss?from=banana`, {
        headers: headers(ctx),
      });
      expect(bad.status).toBe(400);
      const flipped = await ctx.app.request(
        `/api/companies/${ctx.companyId}/profit-loss?from=2026-06-01&to=2026-01-01`,
        { headers: headers(ctx) },
      );
      expect(flipped.status).toBe(400);
    } finally {
      await close();
    }
  });

  it('404s a company in another account', async () => {
    const { ctx, close } = await setup('pl-a@example.com');
    try {
      const bCookie = await signUp(ctx.app, 'pl-b@example.com');
      const b = await userContext('pl-b@example.com');
      const res = await ctx.app.request(`/api/companies/${ctx.companyId}/profit-loss`, {
        headers: { cookie: bCookie, 'x-account-id': b.accountId },
      });
      expect(res.status).toBe(404);
    } finally {
      await close();
    }
  });
});

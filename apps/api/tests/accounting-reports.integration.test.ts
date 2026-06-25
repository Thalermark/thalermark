import { authUser, chartOfAccounts, companies, memberships } from '@thalermark/db';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// Accounting reports: balance-sheet (A = L + E with net income folded into
// equity), ar-aging (outstanding sent invoices bucketed by days past due),
// sales-tax (Sales Tax Payable movement over a window).

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

async function createContact(ctx: Ctx, name = 'Acme'): Promise<string> {
  const res = await ctx.app.request('/api/contacts', {
    method: 'POST',
    headers: headers(ctx),
    body: JSON.stringify({ companyId: ctx.companyId, name }),
  });
  if (res.status !== 201) throw new Error(`customer create failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

async function createInvoice(
  ctx: Ctx,
  contactId: string,
  opts: {
    number: string;
    issueDate: string;
    dueDate: string;
    subtotal: string;
    tax: string;
    total: string;
  },
): Promise<string> {
  const res = await ctx.app.request('/api/invoices', {
    method: 'POST',
    headers: headers(ctx),
    body: JSON.stringify({
      companyId: ctx.companyId,
      contactId,
      number: opts.number,
      issueDate: opts.issueDate,
      dueDate: opts.dueDate,
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

async function createExpense(ctx: Ctx, categoryCode: string, amount: string, expenseDate: string) {
  const categoryAccountId = await coaId(ctx.companyId, categoryCode);
  const paymentAccountId = await coaId(ctx.companyId, '1000');
  const res = await ctx.app.request('/api/expenses', {
    method: 'POST',
    headers: headers(ctx),
    body: JSON.stringify({
      companyId: ctx.companyId,
      categoryAccountId,
      paymentAccountId,
      amount,
      expenseDate,
      merchant: 'Vendor',
    }),
  });
  if (res.status !== 201)
    throw new Error(`expense create failed: ${res.status} ${await res.text()}`);
}

describe('GET /api/companies/:id/balance-sheet', () => {
  beforeEach(resetDb);

  it('balances: assets = liabilities + equity (net income folded in)', async () => {
    const { ctx, close } = await setup('bs@example.com');
    try {
      const today = new Date().toISOString().slice(0, 10);
      const cust = await createContact(ctx);
      // Paid invoice: subtotal 100, tax 8.25, total 108.25 (sent → paid).
      const inv = await createInvoice(ctx, cust, {
        number: 'A',
        issueDate: today,
        dueDate: today,
        subtotal: '100.00',
        tax: '8.25',
        total: '108.25',
      });
      await post(ctx, `/api/invoices/${inv}/mark-sent`);
      await post(ctx, `/api/invoices/${inv}/mark-paid`, { method: 'cash' });
      // Expense 30 paid from cash.
      await createExpense(ctx, '6100', '30.00', today);

      const res = await ctx.app.request(`/api/companies/${ctx.companyId}/balance-sheet`, {
        headers: headers(ctx),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        assets: { code: string; amount: string }[];
        liabilities: { code: string; amount: string }[];
        netIncome: string;
        totalAssets: string;
        totalLiabilities: string;
        totalEquity: string;
        totalLiabilitiesAndEquity: string;
        balanced: boolean;
      };
      // Cash = 108.25 − 30 = 78.25; AR netted to 0 (dropped).
      expect(body.assets).toEqual([{ code: '1000', name: 'Cash', amount: '78.25' }]);
      // Sales Tax Payable 8.25.
      expect(body.liabilities).toEqual([
        { code: '2200', name: 'Sales Tax Payable', amount: '8.25' },
      ]);
      // Revenue 100 − expense 30 = 70.
      expect(body.netIncome).toBe('70.00');
      expect(body.totalAssets).toBe('78.25');
      expect(body.totalLiabilities).toBe('8.25');
      expect(body.totalEquity).toBe('70.00');
      expect(body.totalLiabilitiesAndEquity).toBe('78.25');
      expect(body.balanced).toBe(true);
    } finally {
      await close();
    }
  });

  it('400s a malformed asOf', async () => {
    const { ctx, close } = await setup('bs-bad@example.com');
    try {
      const res = await ctx.app.request(`/api/companies/${ctx.companyId}/balance-sheet?asOf=nope`, {
        headers: headers(ctx),
      });
      expect(res.status).toBe(400);
    } finally {
      await close();
    }
  });
});

describe('GET /api/companies/:id/ar-aging', () => {
  beforeEach(resetDb);

  it('buckets outstanding invoices by days past due', async () => {
    const { ctx, close } = await setup('ar@example.com');
    try {
      const cust = await createContact(ctx);
      const mk = async (number: string, dueDate: string, total: string) => {
        const inv = await createInvoice(ctx, cust, {
          number,
          issueDate: '2026-01-01',
          dueDate,
          subtotal: total,
          tax: '0.00',
          total,
        });
        await post(ctx, `/api/invoices/${inv}/mark-sent`);
        return inv;
      };
      await mk('CUR', '2026-06-20', '100.00'); // not yet due as of 06-15 → current
      await mk('D30', '2026-06-01', '50.00'); // 14 days past → 1-30
      await mk('D90', '2026-01-01', '200.00'); // 165 days past → 90+
      // A paid invoice should not appear.
      const paid = await mk('PAID', '2026-05-01', '999.00');
      await post(ctx, `/api/invoices/${paid}/mark-paid`, { method: 'cash' });

      const res = await ctx.app.request(
        `/api/companies/${ctx.companyId}/ar-aging?asOf=2026-06-15`,
        {
          headers: headers(ctx),
        },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        buckets: { key: string; count: number; amount: string }[];
        invoices: { number: string; daysPastDue: number }[];
        total: string;
      };
      const byKey = Object.fromEntries(body.buckets.map((b) => [b.key, b]));
      expect(byKey.current).toMatchObject({ count: 1, amount: '100.00' });
      expect(byKey['1-30']).toMatchObject({ count: 1, amount: '50.00' });
      expect(byKey['31-60']).toMatchObject({ count: 0, amount: '0.00' });
      expect(byKey['90+']).toMatchObject({ count: 1, amount: '200.00' });
      expect(body.total).toBe('350.00');
      // Most overdue first; paid invoice excluded.
      expect(body.invoices.map((i) => i.number)).toEqual(['D90', 'D30', 'CUR']);
      expect(body.invoices[0]?.daysPastDue).toBe(165);
    } finally {
      await close();
    }
  });
});

describe('GET /api/companies/:id/sales-tax', () => {
  beforeEach(resetDb);

  it('sums Sales Tax Payable movement, net of voids', async () => {
    const { ctx, close } = await setup('tax@example.com');
    try {
      const today = new Date().toISOString().slice(0, 10);
      const cust = await createContact(ctx);
      const mk = async (number: string, tax: string, subtotal: string) => {
        const total = (Number(subtotal) + Number(tax)).toFixed(2);
        const inv = await createInvoice(ctx, cust, {
          number,
          issueDate: today,
          dueDate: today,
          subtotal,
          tax,
          total,
        });
        await post(ctx, `/api/invoices/${inv}/mark-sent`);
        return inv;
      };
      await mk('A', '8.25', '100.00');
      await mk('B', '5.00', '60.00');
      const voided = await mk('C', '10.00', '90.00');
      await post(ctx, `/api/invoices/${voided}/void`); // reverses its 10.00

      // Default window is YTD-through-today, which includes the postings (now).
      const res = await ctx.app.request(`/api/companies/${ctx.companyId}/sales-tax`, {
        headers: headers(ctx),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { months: { collected: string }[]; total: string };
      expect(body.total).toBe('13.25');
      const monthsSum = body.months.reduce((s, m) => s + Number(m.collected), 0).toFixed(2);
      expect(monthsSum).toBe('13.25');
    } finally {
      await close();
    }
  });

  it('400s a malformed from', async () => {
    const { ctx, close } = await setup('tax-bad@example.com');
    try {
      const res = await ctx.app.request(`/api/companies/${ctx.companyId}/sales-tax?from=nope`, {
        headers: headers(ctx),
      });
      expect(res.status).toBe(400);
    } finally {
      await close();
    }
  });

  it('404s a company in another account', async () => {
    const { ctx, close } = await setup('acct-a@example.com');
    try {
      const bCookie = await signUp(ctx.app, 'acct-b@example.com');
      const b = await userContext('acct-b@example.com');
      const res = await ctx.app.request(`/api/companies/${ctx.companyId}/balance-sheet`, {
        headers: { cookie: bCookie, 'x-account-id': b.accountId },
      });
      expect(res.status).toBe(404);
    } finally {
      await close();
    }
  });
});

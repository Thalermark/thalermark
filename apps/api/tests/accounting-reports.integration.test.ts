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

// TMC-216 — one number for "who owes me?". Three surfaces answered that
// question three different ways once TMC-187 shipped partial payments: the
// dashboard read the AR ledger balance (right), while the invoices-list metric
// strip and this aging report both summed invoice totals and ignored every
// receipt. These tests pin the agreement, not just each surface on its own.
describe('outstanding A/R agrees across dashboard, invoices strip and aging', () => {
  beforeEach(resetDb);

  type AgingBody = {
    asOf: string;
    buckets: { key: string; label: string; count: number; amount: string }[];
    invoices: {
      id: string;
      number: string;
      customerName: string | null;
      dueDate: string;
      daysPastDue: number;
      amount: string;
    }[];
    total: string;
  };
  type SummaryBody = {
    draft: { count: number };
    awaiting: { count: number; total: string };
    overdue: { count: number; total: string };
  };
  type DashboardBody = { moneyIn: string; moneyOut: string; owed: string; owing: string };

  // The real receipt path — POST /api/invoices/:id/payments (TMC-187), the same
  // endpoint the deposit UI calls. Deliberately not an INSERT into
  // invoice_payments: the ledger posting is what makes the dashboard's figure
  // move, so the test has to go through the code that posts it.
  async function recordPayment(
    ctx: Ctx,
    invoiceId: string,
    body: { amount: string; receivedOn: string; method: 'cash' | 'check' },
  ): Promise<void> {
    const res = await ctx.app.request(`/api/invoices/${invoiceId}/payments`, {
      method: 'POST',
      headers: headers(ctx),
      body: JSON.stringify(body),
    });
    if (res.status !== 201) throw new Error(`payment failed: ${res.status} ${await res.text()}`);
  }

  async function sendInvoice(
    ctx: Ctx,
    contactId: string,
    opts: { number: string; dueDate: string; total: string },
  ): Promise<string> {
    const id = await createInvoice(ctx, contactId, {
      number: opts.number,
      issueDate: '2026-05-01',
      dueDate: opts.dueDate,
      subtotal: opts.total,
      tax: '0.00',
      total: opts.total,
    });
    await post(ctx, `/api/invoices/${id}/mark-sent`);
    return id;
  }

  async function arAging(ctx: Ctx, query = ''): Promise<AgingBody> {
    const res = await ctx.app.request(`/api/companies/${ctx.companyId}/ar-aging${query}`, {
      headers: headers(ctx),
    });
    if (res.status !== 200) throw new Error(`ar-aging failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as AgingBody;
  }

  async function invoiceSummary(ctx: Ctx): Promise<SummaryBody> {
    const res = await ctx.app.request(`/api/invoices/summary?companyId=${ctx.companyId}`, {
      headers: headers(ctx),
    });
    if (res.status !== 200) throw new Error(`summary failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as SummaryBody;
  }

  // The dashboard's owed figure is the live AR ledger balance — point-in-time,
  // so the window only bounds money in/out and cannot move this number.
  async function dashboardOwed(ctx: Ctx): Promise<string> {
    const res = await ctx.app.request(
      `/api/companies/${ctx.companyId}/dashboard?from=2026-01-01&to=2026-12-31`,
      { headers: headers(ctx) },
    );
    if (res.status !== 200) throw new Error(`dashboard failed: ${res.status} ${await res.text()}`);
    return ((await res.json()) as DashboardBody).owed;
  }

  it('reports the same owed figure on all three surfaces after a deposit', async () => {
    const { ctx, close } = await setup('owed-agree@example.com');
    try {
      const cust = await createContact(ctx);
      // $1,000 billed, $250 received. Due far in the future so the invoice is
      // unambiguously in the summary's 'awaiting' bucket (dueDate >= today)
      // whenever the suite runs.
      const inv = await sendInvoice(ctx, cust, {
        number: 'INV-DEP',
        dueDate: '2999-12-31',
        total: '1000.00',
      });
      await recordPayment(ctx, inv, {
        amount: '250.00',
        receivedOn: '2026-05-15',
        method: 'cash',
      });

      const owed = await dashboardOwed(ctx);
      const summary = await invoiceSummary(ctx);
      const aging = await arAging(ctx);

      // The value, not just the agreement — three equal wrong numbers would
      // satisfy mutual equality on its own.
      expect(owed).toBe('750.00');
      expect(summary.awaiting.total).toBe('750.00');
      expect(aging.total).toBe('750.00');
      // ...and the agreement, stated as the thing the ticket is actually about.
      expect(new Set([owed, summary.awaiting.total, aging.total]).size).toBe(1);
      // The invoice is still one invoice awaiting payment, for less money.
      expect(summary.awaiting.count).toBe(1);
    } finally {
      await close();
    }
  });

  it('ages the outstanding amount, not the invoice total', async () => {
    const { ctx, close } = await setup('owed-buckets@example.com');
    try {
      const cust = await createContact(ctx);
      // Both land in 1–30 as of 2026-06-15; distinct due dates keep the list
      // order deterministic (most overdue first).
      const part = await sendInvoice(ctx, cust, {
        number: 'INV-PART',
        dueDate: '2026-06-01',
        total: '500.00',
      });
      await recordPayment(ctx, part, {
        amount: '125.00',
        receivedOn: '2026-06-10',
        method: 'check',
      });
      await sendInvoice(ctx, cust, {
        number: 'INV-OPEN',
        dueDate: '2026-06-05',
        total: '100.00',
      });

      const aging = await arAging(ctx, '?asOf=2026-06-15');
      const byKey = Object.fromEntries(aging.buckets.map((b) => [b.key, b]));
      // 375 still owed on INV-PART + 100 on INV-OPEN. Summing totals would say
      // 600.00 here.
      expect(byKey['1-30']).toMatchObject({ count: 2, amount: '475.00' });
      expect(aging.total).toBe('475.00');
      // The per-invoice amount is likewise what is left, not what was billed.
      expect(aging.invoices.map((i) => i.number)).toEqual(['INV-PART', 'INV-OPEN']);
      expect(aging.invoices[0]?.amount).toBe('375.00');
      expect(aging.invoices[1]?.amount).toBe('100.00');
    } finally {
      await close();
    }
  });

  it('drops a fully-settled invoice from the aging list and the summary totals', async () => {
    const { ctx, close } = await setup('owed-settled@example.com');
    try {
      const cust = await createContact(ctx);
      // Settled in two instalments through the payments endpoint — the path
      // that has to behave like the old single-shot mark-paid once the balance
      // reaches zero.
      const settled = await sendInvoice(ctx, cust, {
        number: 'INV-SETTLED',
        dueDate: '2999-12-31',
        total: '1000.00',
      });
      await recordPayment(ctx, settled, {
        amount: '400.00',
        receivedOn: '2026-05-10',
        method: 'cash',
      });
      await recordPayment(ctx, settled, {
        amount: '600.00',
        receivedOn: '2026-05-20',
        method: 'cash',
      });
      const open = await sendInvoice(ctx, cust, {
        number: 'INV-STILL-OPEN',
        dueDate: '2999-12-31',
        total: '800.00',
      });
      await recordPayment(ctx, open, {
        amount: '300.00',
        receivedOn: '2026-05-20',
        method: 'cash',
      });

      const aging = await arAging(ctx);
      expect(aging.invoices.map((i) => i.number)).toEqual(['INV-STILL-OPEN']);
      expect(aging.total).toBe('500.00');
      const byKey = Object.fromEntries(aging.buckets.map((b) => [b.key, b]));
      expect(byKey.current).toMatchObject({ count: 1, amount: '500.00' });

      const summary = await invoiceSummary(ctx);
      expect(summary.awaiting.count).toBe(1);
      expect(summary.awaiting.total).toBe('500.00');
      expect(summary.overdue.count).toBe(0);

      // And the ledger says the same thing.
      expect(await dashboardOwed(ctx)).toBe('500.00');
    } finally {
      await close();
    }
  });

  it('counts a part-paid invoice once however many receipts it carries', async () => {
    const { ctx, close } = await setup('owed-counts@example.com');
    try {
      const cust = await createContact(ctx);
      const inv = await sendInvoice(ctx, cust, {
        number: 'INV-MULTI',
        dueDate: '2999-12-31',
        total: '900.00',
      });
      for (const [amount, receivedOn] of [
        ['100.00', '2026-05-10'],
        ['200.00', '2026-05-11'],
        ['50.00', '2026-05-12'],
      ] as const) {
        await recordPayment(ctx, inv, { amount, receivedOn, method: 'cash' });
      }

      // The summary joins a grouped receipts subquery. If that join ever
      // multiplied rows — one row per payment instead of one per invoice — the
      // count would read 3 and the money would triple. It is one invoice.
      const summary = await invoiceSummary(ctx);
      expect(summary.awaiting.count).toBe(1);
      expect(summary.awaiting.total).toBe('550.00');
      expect(summary.draft.count).toBe(0);

      const aging = await arAging(ctx);
      expect(aging.invoices).toHaveLength(1);
      expect(aging.invoices[0]?.amount).toBe('550.00');
      const byKey = Object.fromEntries(aging.buckets.map((b) => [b.key, b]));
      expect(byKey.current).toMatchObject({ count: 1, amount: '550.00' });
      expect(await dashboardOwed(ctx)).toBe('550.00');
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

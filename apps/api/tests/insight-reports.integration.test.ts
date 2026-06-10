import { authUser, companies, memberships } from '@thalermark/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// Business-insight reports: sales-by-customer, revenue-over-time,
// estimate-win-rate. All window by issueDate; tests pass explicit from/to so
// they don't depend on the wall clock.

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

async function createCustomer(ctx: Ctx, name: string): Promise<string> {
  const res = await ctx.app.request('/api/customers', {
    method: 'POST',
    headers: headers(ctx),
    body: JSON.stringify({ companyId: ctx.companyId, name }),
  });
  if (res.status !== 201) throw new Error(`customer create failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

async function createInvoice(
  ctx: Ctx,
  customerId: string,
  opts: { number: string; issueDate: string; subtotal: string },
): Promise<string> {
  const res = await ctx.app.request('/api/invoices', {
    method: 'POST',
    headers: headers(ctx),
    body: JSON.stringify({
      companyId: ctx.companyId,
      customerId,
      number: opts.number,
      issueDate: opts.issueDate,
      dueDate: opts.issueDate,
      subtotal: opts.subtotal,
      tax: '0.00',
      total: opts.subtotal,
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

async function createEstimate(
  ctx: Ctx,
  opts: { number: string; issueDate: string; subtotal: string },
): Promise<string> {
  const customerId = await createCustomer(ctx, `Cust ${opts.number}`);
  const res = await ctx.app.request('/api/estimates', {
    method: 'POST',
    headers: headers(ctx),
    body: JSON.stringify({
      companyId: ctx.companyId,
      customerId,
      number: opts.number,
      issueDate: opts.issueDate,
      expiresOn: opts.issueDate,
      subtotal: opts.subtotal,
      tax: '0.00',
      total: opts.subtotal,
      lineItems: [
        {
          position: 1,
          description: 'Quote',
          quantity: '1',
          unitPrice: opts.subtotal,
          amount: opts.subtotal,
        },
      ],
    }),
  });
  if (res.status !== 201)
    throw new Error(`estimate create failed: ${res.status} ${await res.text()}`);
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

const WINDOW = '?from=2026-01-01&to=2026-12-31';

describe('GET /api/companies/:id/sales-by-customer', () => {
  beforeEach(resetDb);

  it('ranks customers by pre-tax sales (sent or paid), excludes drafts', async () => {
    const { ctx, close } = await setup('sbc@example.com');
    try {
      const x = await createCustomer(ctx, 'Customer X');
      const y = await createCustomer(ctx, 'Customer Y');

      const x1 = await createInvoice(ctx, x, {
        number: 'X1',
        issueDate: '2026-03-01',
        subtotal: '100.00',
      });
      await post(ctx, `/api/invoices/${x1}/mark-sent`);
      const x2 = await createInvoice(ctx, x, {
        number: 'X2',
        issueDate: '2026-04-01',
        subtotal: '200.00',
      });
      await post(ctx, `/api/invoices/${x2}/mark-sent`);
      await post(ctx, `/api/invoices/${x2}/mark-paid`, { method: 'cash' });
      const y1 = await createInvoice(ctx, y, {
        number: 'Y1',
        issueDate: '2026-05-01',
        subtotal: '150.00',
      });
      await post(ctx, `/api/invoices/${y1}/mark-sent`);
      // Draft for X — must not count.
      await createInvoice(ctx, x, { number: 'X3', issueDate: '2026-06-01', subtotal: '999.00' });

      const res = await ctx.app.request(
        `/api/companies/${ctx.companyId}/sales-by-customer${WINDOW}`,
        { headers: headers(ctx) },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        customers: { name: string; sales: string; invoiceCount: number }[];
        totalSales: string;
      };
      expect(body.customers).toEqual([
        { customerId: expect.any(String), name: 'Customer X', sales: '300.00', invoiceCount: 2 },
        { customerId: expect.any(String), name: 'Customer Y', sales: '150.00', invoiceCount: 1 },
      ]);
      expect(body.totalSales).toBe('450.00');
    } finally {
      await close();
    }
  });
});

describe('GET /api/companies/:id/revenue-over-time', () => {
  beforeEach(resetDb);

  it('buckets pre-tax sales by month', async () => {
    const { ctx, close } = await setup('rot@example.com');
    try {
      const cust = await createCustomer(ctx, 'C');
      const a = await createInvoice(ctx, cust, {
        number: 'A',
        issueDate: '2026-02-15',
        subtotal: '100.00',
      });
      await post(ctx, `/api/invoices/${a}/mark-sent`);
      const b = await createInvoice(ctx, cust, {
        number: 'B',
        issueDate: '2026-03-10',
        subtotal: '200.00',
      });
      await post(ctx, `/api/invoices/${b}/mark-sent`);
      const d = await createInvoice(ctx, cust, {
        number: 'D',
        issueDate: '2026-03-20',
        subtotal: '50.00',
      });
      await post(ctx, `/api/invoices/${d}/mark-sent`);

      const res = await ctx.app.request(
        `/api/companies/${ctx.companyId}/revenue-over-time${WINDOW}`,
        { headers: headers(ctx) },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        months: { month: string; revenue: string }[];
        total: string;
      };
      expect(body.months).toEqual([
        { month: '2026-02', revenue: '100.00' },
        { month: '2026-03', revenue: '250.00' },
      ]);
      expect(body.total).toBe('350.00');
    } finally {
      await close();
    }
  });
});

describe('GET /api/companies/:id/estimate-win-rate', () => {
  beforeEach(resetDb);

  it('computes per-status counts/value and the win rate', async () => {
    const { ctx, close } = await setup('ewr@example.com');
    try {
      // 2 accepted (100 each), 1 declined (50), 1 sent-pending (200), 1 draft (30).
      for (const n of ['A1', 'A2']) {
        const e = await createEstimate(ctx, {
          number: n,
          issueDate: '2026-03-01',
          subtotal: '100.00',
        });
        await post(ctx, `/api/estimates/${e}/mark-sent`);
        await post(ctx, `/api/estimates/${e}/mark-accepted`);
      }
      const dec = await createEstimate(ctx, {
        number: 'D1',
        issueDate: '2026-03-02',
        subtotal: '50.00',
      });
      await post(ctx, `/api/estimates/${dec}/mark-sent`);
      await post(ctx, `/api/estimates/${dec}/mark-declined`);
      const sent = await createEstimate(ctx, {
        number: 'S1',
        issueDate: '2026-03-03',
        subtotal: '200.00',
      });
      await post(ctx, `/api/estimates/${sent}/mark-sent`);
      await createEstimate(ctx, { number: 'DR1', issueDate: '2026-03-04', subtotal: '30.00' }); // draft

      const res = await ctx.app.request(
        `/api/companies/${ctx.companyId}/estimate-win-rate${WINDOW}`,
        { headers: headers(ctx) },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        byStatus: { status: string; count: number; value: string }[];
        acceptedCount: number;
        decidedCount: number;
        winRate: string | null;
      };
      const byStatus = Object.fromEntries(body.byStatus.map((s) => [s.status, s]));
      expect(byStatus.accepted).toEqual({ status: 'accepted', count: 2, value: '200.00' });
      expect(byStatus.declined).toEqual({ status: 'declined', count: 1, value: '50.00' });
      expect(byStatus.sent).toEqual({ status: 'sent', count: 1, value: '200.00' });
      expect(byStatus.draft).toEqual({ status: 'draft', count: 1, value: '30.00' });
      expect(byStatus.expired).toEqual({ status: 'expired', count: 0, value: '0.00' });
      expect(body.acceptedCount).toBe(2);
      expect(body.decidedCount).toBe(3);
      expect(body.winRate).toBe('0.6667');
    } finally {
      await close();
    }
  });

  it('returns winRate null when nothing is decided', async () => {
    const { ctx, close } = await setup('ewr-empty@example.com');
    try {
      const e = await createEstimate(ctx, {
        number: 'P1',
        issueDate: '2026-03-01',
        subtotal: '100.00',
      });
      await post(ctx, `/api/estimates/${e}/mark-sent`);
      const res = await ctx.app.request(
        `/api/companies/${ctx.companyId}/estimate-win-rate${WINDOW}`,
        { headers: headers(ctx) },
      );
      const body = (await res.json()) as { winRate: string | null; decidedCount: number };
      expect(body.decidedCount).toBe(0);
      expect(body.winRate).toBeNull();
    } finally {
      await close();
    }
  });
});

describe('insight reports — shared window validation', () => {
  beforeEach(resetDb);

  it('400s a malformed from on each endpoint', async () => {
    const { ctx, close } = await setup('win@example.com');
    try {
      for (const path of ['sales-by-customer', 'revenue-over-time', 'estimate-win-rate']) {
        const res = await ctx.app.request(`/api/companies/${ctx.companyId}/${path}?from=banana`, {
          headers: headers(ctx),
        });
        expect(res.status, path).toBe(400);
      }
    } finally {
      await close();
    }
  });

  it('404s a company in another account', async () => {
    const { ctx, close } = await setup('win-a@example.com');
    try {
      const bCookie = await signUp(ctx.app, 'win-b@example.com');
      const b = await userContext('win-b@example.com');
      const res = await ctx.app.request(`/api/companies/${ctx.companyId}/sales-by-customer`, {
        headers: { cookie: bCookie, 'x-account-id': b.accountId },
      });
      expect(res.status).toBe(404);
    } finally {
      await close();
    }
  });
});

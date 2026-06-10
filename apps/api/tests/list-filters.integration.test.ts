import { authUser, companies, memberships } from '@thalermark/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// Covers the list-filter query params added alongside the web/mobile filter
// bars: q / from / to / customerId on invoices + estimates, and q /
// openInvoices on customers. The status filter is exercised by the existing
// invoices + estimates suites; these tests are about the new params.

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

function authHeaders(ctx: Ctx) {
  return { cookie: ctx.cookie, 'x-account-id': ctx.accountId, 'content-type': 'application/json' };
}

async function createCustomer(ctx: Ctx, name: string, email?: string): Promise<string> {
  const res = await ctx.app.request('/api/customers', {
    method: 'POST',
    headers: authHeaders(ctx),
    body: JSON.stringify(
      email ? { companyId: ctx.companyId, name, email } : { companyId: ctx.companyId, name },
    ),
  });
  if (res.status !== 201) throw new Error(`customer create failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

async function createInvoice(
  ctx: Ctx,
  customerId: string,
  opts: { number: string; issueDate: string },
): Promise<string> {
  const res = await ctx.app.request('/api/invoices', {
    method: 'POST',
    headers: authHeaders(ctx),
    body: JSON.stringify({
      companyId: ctx.companyId,
      customerId,
      number: opts.number,
      issueDate: opts.issueDate,
      dueDate: opts.issueDate,
      subtotal: '100.00',
      tax: '0.00',
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
  if (res.status !== 201)
    throw new Error(`invoice create failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

async function createEstimate(
  ctx: Ctx,
  customerId: string,
  opts: { number: string; issueDate: string },
): Promise<string> {
  const res = await ctx.app.request('/api/estimates', {
    method: 'POST',
    headers: authHeaders(ctx),
    body: JSON.stringify({
      companyId: ctx.companyId,
      customerId,
      number: opts.number,
      issueDate: opts.issueDate,
      expiresOn: opts.issueDate,
      subtotal: '100.00',
      tax: '0.00',
      total: '100.00',
      lineItems: [
        { position: 1, description: 'Quote', quantity: '1', unitPrice: '100.00', amount: '100.00' },
      ],
    }),
  });
  if (res.status !== 201)
    throw new Error(`estimate create failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

async function listInvoiceNumbers(ctx: Ctx, query: string): Promise<string[]> {
  const res = await ctx.app.request(`/api/invoices${query}`, { headers: authHeaders(ctx) });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { invoices: { number: string }[] };
  return body.invoices.map((i) => i.number).sort();
}

async function listEstimateNumbers(ctx: Ctx, query: string): Promise<string[]> {
  const res = await ctx.app.request(`/api/estimates${query}`, { headers: authHeaders(ctx) });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { estimates: { number: string }[] };
  return body.estimates.map((e) => e.number).sort();
}

async function listCustomerNames(ctx: Ctx, query: string): Promise<string[]> {
  const res = await ctx.app.request(`/api/customers${query}`, { headers: authHeaders(ctx) });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { customers: { name: string }[] };
  return body.customers.map((c) => c.name).sort();
}

describe('GET /api/invoices filters', () => {
  beforeEach(resetDb);

  it('filters by q (number), q (customer name), date range, and customerId', async () => {
    const { ctx, close } = await setup('inv-filter@example.com');
    try {
      const acme = await createCustomer(ctx, 'Acme Landscaping');
      const globex = await createCustomer(ctx, 'Globex Hauling');
      await createInvoice(ctx, acme, { number: 'INV-100', issueDate: '2026-01-15' });
      await createInvoice(ctx, globex, { number: 'INV-200', issueDate: '2026-03-20' });

      // q on the invoice number.
      expect(await listInvoiceNumbers(ctx, '?q=INV-100')).toEqual(['INV-100']);
      // q on the joined customer name (case-insensitive).
      expect(await listInvoiceNumbers(ctx, '?q=globex')).toEqual(['INV-200']);
      // Inclusive date range on issueDate.
      expect(await listInvoiceNumbers(ctx, '?from=2026-02-01')).toEqual(['INV-200']);
      expect(await listInvoiceNumbers(ctx, '?to=2026-02-01')).toEqual(['INV-100']);
      expect(await listInvoiceNumbers(ctx, '?from=2026-01-15&to=2026-03-20')).toEqual([
        'INV-100',
        'INV-200',
      ]);
      // Single-customer narrowing.
      expect(await listInvoiceNumbers(ctx, `?customerId=${acme}`)).toEqual(['INV-100']);
    } finally {
      await close();
    }
  });

  it('400s on a malformed from / customerId', async () => {
    const { ctx, close } = await setup('inv-bad@example.com');
    try {
      const banana = await ctx.app.request('/api/invoices?from=banana', {
        headers: authHeaders(ctx),
      });
      expect(banana.status).toBe(400);
      const badId = await ctx.app.request('/api/invoices?customerId=not-a-uuid', {
        headers: authHeaders(ctx),
      });
      expect(badId.status).toBe(400);
    } finally {
      await close();
    }
  });
});

describe('GET /api/estimates filters', () => {
  beforeEach(resetDb);

  it('filters by q and date range', async () => {
    const { ctx, close } = await setup('est-filter@example.com');
    try {
      const acme = await createCustomer(ctx, 'Acme Landscaping');
      const globex = await createCustomer(ctx, 'Globex Hauling');
      await createEstimate(ctx, acme, { number: 'EST-100', issueDate: '2026-01-15' });
      await createEstimate(ctx, globex, { number: 'EST-200', issueDate: '2026-03-20' });

      expect(await listEstimateNumbers(ctx, '?q=EST-200')).toEqual(['EST-200']);
      expect(await listEstimateNumbers(ctx, '?q=acme')).toEqual(['EST-100']);
      expect(await listEstimateNumbers(ctx, '?to=2026-02-01')).toEqual(['EST-100']);
      expect(await listEstimateNumbers(ctx, `?customerId=${globex}`)).toEqual(['EST-200']);
    } finally {
      await close();
    }
  });
});

describe('GET /api/customers filters', () => {
  beforeEach(resetDb);

  it('filters by q (name OR email)', async () => {
    const { ctx, close } = await setup('cust-filter@example.com');
    try {
      await createCustomer(ctx, 'Acme Landscaping', 'billing@acme.test');
      await createCustomer(ctx, 'Globex Hauling', 'ar@globex.test');

      expect(await listCustomerNames(ctx, '?q=acme')).toEqual(['Acme Landscaping']);
      // Match against the email column.
      expect(await listCustomerNames(ctx, '?q=globex.test')).toEqual(['Globex Hauling']);
      // No match.
      expect(await listCustomerNames(ctx, '?q=nobody')).toEqual([]);
    } finally {
      await close();
    }
  });

  it('openInvoices returns only customers with an issued (sent) unpaid invoice', async () => {
    const { ctx, close } = await setup('cust-open@example.com');
    try {
      const owing = await createCustomer(ctx, 'Owing Co');
      await createCustomer(ctx, 'Clear Co');
      const draftCust = await createCustomer(ctx, 'Draft Co');

      // Owing Co: invoice marked sent → open.
      const sentInv = await createInvoice(ctx, owing, {
        number: 'INV-OPEN',
        issueDate: '2026-02-01',
      });
      const mark = await ctx.app.request(`/api/invoices/${sentInv}/mark-sent`, {
        method: 'POST',
        headers: authHeaders(ctx),
      });
      expect(mark.status).toBe(200);

      // Draft Co: invoice left in draft → not open.
      await createInvoice(ctx, draftCust, { number: 'INV-DRAFT', issueDate: '2026-02-01' });

      expect(await listCustomerNames(ctx, '?openInvoices=true')).toEqual(['Owing Co']);
      // Without the flag, all three customers list.
      expect(await listCustomerNames(ctx, '')).toEqual(['Clear Co', 'Draft Co', 'Owing Co']);
    } finally {
      await close();
    }
  });
});

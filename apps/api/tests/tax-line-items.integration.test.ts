import { authUser, companies, memberships } from '@thalermark/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

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
  if (!m) throw new Error(`membership for ${email} not seeded by hook`);
  const [company] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.accountId, m.accountId));
  if (!company) throw new Error(`default company for ${email} not seeded by hook`);
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

function hdr(ctx: Ctx) {
  return { cookie: ctx.cookie, 'x-account-id': ctx.accountId, 'content-type': 'application/json' };
}

async function setup(
  email: string,
): Promise<{ ctx: Ctx; handle: ReturnType<typeof createApiDatabase>; customerId: string }> {
  const { app, handle } = buildApp();
  const cookie = await signUp(app, email);
  const { accountId, companyId } = await userContext(email);
  const ctx: Ctx = { app, cookie, accountId, companyId };
  const cust = await app.request('/api/customers', {
    method: 'POST',
    headers: hdr(ctx),
    body: JSON.stringify({ companyId, name: 'Wile E. Coyote' }),
  });
  const customerId = ((await cust.json()) as { id: string }).id;
  return { ctx, handle, customerId };
}

// One taxable part line (8.25% of 120 = 9.90) + one non-taxable labor line.
// Header tax is the client-computed sum of line tax (9.90).
function mixedLines() {
  return [
    {
      position: 1,
      description: 'Hard drive replacement — part',
      quantity: '1',
      unitPrice: '120.00',
      amount: '120.00',
      taxable: true,
      taxRatePct: '8.25',
      taxAmount: '9.90',
    },
    {
      position: 2,
      description: 'Labor',
      quantity: '1',
      unitPrice: '80.00',
      amount: '80.00',
    },
  ];
}

type LineOut = { taxable: boolean; taxRatePct: string; taxAmount: string };

describe('per-line tax — invoices', () => {
  beforeEach(resetDb);

  it('round-trips per-line tax and the derived header tax', async () => {
    const { ctx, handle, customerId } = await setup('tax-inv@example.com');
    try {
      const create = await ctx.app.request('/api/invoices', {
        method: 'POST',
        headers: hdr(ctx),
        body: JSON.stringify({
          companyId: ctx.companyId,
          customerId,
          number: 'INV-T1',
          issueDate: '2026-06-14',
          dueDate: '2026-07-14',
          subtotal: '200.00',
          tax: '9.90',
          total: '209.90',
          lineItems: mixedLines(),
        }),
      });
      expect(create.status).toBe(201);
      const { id } = (await create.json()) as { id: string };

      const detail = await ctx.app.request(`/api/invoices/${id}`, { headers: hdr(ctx) });
      const body = (await detail.json()) as { tax: string; lineItems: LineOut[] };
      expect(body.tax).toBe('9.90');
      expect(body.lineItems[0]?.taxable).toBe(true);
      expect(body.lineItems[0]?.taxRatePct).toBe('8.2500');
      expect(body.lineItems[0]?.taxAmount).toBe('9.90');
      // Non-taxable line collapses to column defaults.
      expect(body.lineItems[1]?.taxable).toBe(false);
      expect(body.lineItems[1]?.taxAmount).toBe('0.00');
    } finally {
      await handle.close();
    }
  });

  it('duplicate-as-template carries the line tax snapshot', async () => {
    const { ctx, handle, customerId } = await setup('tax-dup@example.com');
    try {
      const create = await ctx.app.request('/api/invoices', {
        method: 'POST',
        headers: hdr(ctx),
        body: JSON.stringify({
          companyId: ctx.companyId,
          customerId,
          number: 'INV-T2',
          issueDate: '2026-06-14',
          dueDate: '2026-07-14',
          subtotal: '200.00',
          tax: '9.90',
          total: '209.90',
          lineItems: mixedLines(),
        }),
      });
      const { id } = (await create.json()) as { id: string };

      const dup = await ctx.app.request(`/api/invoices/${id}/duplicate`, {
        method: 'POST',
        headers: hdr(ctx),
      });
      expect(dup.status).toBe(201);
      const { id: dupId } = (await dup.json()) as { id: string };

      const detail = await ctx.app.request(`/api/invoices/${dupId}`, { headers: hdr(ctx) });
      const body = (await detail.json()) as { tax: string; lineItems: LineOut[] };
      expect(body.tax).toBe('9.90');
      expect(body.lineItems[0]?.taxable).toBe(true);
      expect(body.lineItems[0]?.taxAmount).toBe('9.90');
    } finally {
      await handle.close();
    }
  });
});

describe('per-line tax — estimate convert', () => {
  beforeEach(resetDb);

  it('carries the estimate line tax snapshot onto the converted invoice', async () => {
    const { ctx, handle, customerId } = await setup('tax-conv@example.com');
    try {
      const create = await ctx.app.request('/api/estimates', {
        method: 'POST',
        headers: hdr(ctx),
        body: JSON.stringify({
          companyId: ctx.companyId,
          customerId,
          number: 'EST-T1',
          issueDate: '2026-06-14',
          subtotal: '200.00',
          tax: '9.90',
          total: '209.90',
          lineItems: mixedLines(),
        }),
      });
      expect(create.status).toBe(201);
      const { id: estId } = (await create.json()) as { id: string };

      await ctx.app.request(`/api/estimates/${estId}/mark-sent`, {
        method: 'POST',
        headers: hdr(ctx),
      });
      await ctx.app.request(`/api/estimates/${estId}/mark-accepted`, {
        method: 'POST',
        headers: hdr(ctx),
      });
      const convert = await ctx.app.request(`/api/estimates/${estId}/convert`, {
        method: 'POST',
        headers: hdr(ctx),
      });
      expect(convert.status).toBe(201);
      const { id: invId } = (await convert.json()) as { id: string };

      const detail = await ctx.app.request(`/api/invoices/${invId}`, { headers: hdr(ctx) });
      const body = (await detail.json()) as { tax: string; lineItems: LineOut[] };
      expect(body.tax).toBe('9.90');
      expect(body.lineItems[0]?.taxable).toBe(true);
      expect(body.lineItems[0]?.taxRatePct).toBe('8.2500');
      expect(body.lineItems[0]?.taxAmount).toBe('9.90');
      expect(body.lineItems[1]?.taxable).toBe(false);
    } finally {
      await handle.close();
    }
  });
});

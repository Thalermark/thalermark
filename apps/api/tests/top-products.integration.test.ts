import { authUser, companies, memberships } from '@thalermark/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// I5 — top-products report. A deterministic GROUP BY source_item_id aggregate
// over invoice line items, with an "Uncatalogued / other" bucket (null source)
// and a paid-vs-sent basis. Asserts the aggregate, the basis filter, bucket
// placement, archived-item labelling, empty state, validation, and isolation.

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

type Line = {
  description: string;
  quantity: string;
  unitPrice: string;
  amount: string;
  sourceItemId?: string;
};

type Ctx = { cookie: string; accountId: string; companyId: string };

function headers(ctx: Ctx) {
  return { cookie: ctx.cookie, 'x-account-id': ctx.accountId, 'content-type': 'application/json' };
}

async function createItem(
  app: ReturnType<typeof createApp>,
  ctx: Ctx,
  name: string,
  price: string,
) {
  const res = await app.request('/api/items', {
    method: 'POST',
    headers: headers(ctx),
    body: JSON.stringify({ companyId: ctx.companyId, name, unitPrice: price }),
  });
  if (res.status !== 201) throw new Error(`item create failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

async function createCustomer(app: ReturnType<typeof createApp>, ctx: Ctx) {
  const res = await app.request('/api/customers', {
    method: 'POST',
    headers: headers(ctx),
    body: JSON.stringify({ companyId: ctx.companyId, name: 'Coyote' }),
  });
  return ((await res.json()) as { id: string }).id;
}

async function createInvoice(
  app: ReturnType<typeof createApp>,
  ctx: Ctx,
  customerId: string,
  number: string,
  lineItems: Line[],
) {
  const subtotal = lineItems.reduce((s, l) => s + Number(l.amount), 0).toFixed(2);
  const res = await app.request('/api/invoices', {
    method: 'POST',
    headers: headers(ctx),
    body: JSON.stringify({
      companyId: ctx.companyId,
      customerId,
      number,
      issueDate: '2026-06-01',
      dueDate: '2026-07-01',
      subtotal,
      total: subtotal,
      lineItems: lineItems.map((l, i) => ({ position: i + 1, ...l })),
    }),
  });
  if (res.status !== 201)
    throw new Error(`invoice create failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

async function markSent(app: ReturnType<typeof createApp>, ctx: Ctx, id: string) {
  const res = await app.request(`/api/invoices/${id}/mark-sent`, {
    method: 'POST',
    headers: { cookie: ctx.cookie, 'x-account-id': ctx.accountId },
  });
  if (res.status !== 200) throw new Error(`mark-sent failed: ${res.status}`);
}

async function markPaid(app: ReturnType<typeof createApp>, ctx: Ctx, id: string) {
  await markSent(app, ctx, id);
  const res = await app.request(`/api/invoices/${id}/mark-paid`, {
    method: 'POST',
    headers: headers(ctx),
    body: JSON.stringify({ method: 'cash' }),
  });
  if (res.status !== 200) throw new Error(`mark-paid failed: ${res.status}`);
}

type TopProducts = {
  basis: string;
  products: {
    sourceItemId: string | null;
    name: string | null;
    revenue: string;
    lineCount: number;
  }[];
};

async function topProducts(
  app: ReturnType<typeof createApp>,
  ctx: Ctx,
  basis?: string,
): Promise<TopProducts> {
  const q = basis ? `?basis=${basis}` : '';
  const res = await app.request(`/api/companies/${ctx.companyId}/top-products${q}`, {
    headers: { cookie: ctx.cookie, 'x-account-id': ctx.accountId },
  });
  if (res.status !== 200) throw new Error(`top-products failed: ${res.status}`);
  return (await res.json()) as TopProducts;
}

describe('GET /api/companies/:id/top-products', () => {
  beforeEach(resetDb);

  // Shared fixture: item A ($40) + item B ($120); a paid invoice (line A 80 +
  // hand-typed 30), a sent-not-paid invoice (line A 40 + line B 200), and a
  // draft (line B) that should never count.
  async function seedScenario(app: ReturnType<typeof createApp>, email: string) {
    const cookie = await signUp(app, email);
    const { accountId, companyId } = await userContext(email);
    const ctx: Ctx = { cookie, accountId, companyId };
    const itemA = await createItem(app, ctx, 'Mowing', '40.00');
    const itemB = await createItem(app, ctx, 'Washing', '120.00');
    const customer = await createCustomer(app, ctx);

    const paid = await createInvoice(app, ctx, customer, 'INV-1', [
      {
        description: 'Mowing',
        quantity: '2',
        unitPrice: '40.00',
        amount: '80.00',
        sourceItemId: itemA,
      },
      { description: 'Extra cleanup', quantity: '1', unitPrice: '30.00', amount: '30.00' },
    ]);
    await markPaid(app, ctx, paid);

    const sent = await createInvoice(app, ctx, customer, 'INV-2', [
      {
        description: 'Mowing',
        quantity: '1',
        unitPrice: '40.00',
        amount: '40.00',
        sourceItemId: itemA,
      },
      {
        description: 'Washing',
        quantity: '1',
        unitPrice: '200.00',
        amount: '200.00',
        sourceItemId: itemB,
      },
    ]);
    await markSent(app, ctx, sent);

    await createInvoice(app, ctx, customer, 'INV-3', [
      {
        description: 'Washing',
        quantity: '1',
        unitPrice: '120.00',
        amount: '120.00',
        sourceItemId: itemB,
      },
    ]); // left as draft

    return { ctx, itemA, itemB };
  }

  it('defaults to the paid basis: only paid invoices, bucket last', async () => {
    const { app, handle } = buildApp();
    try {
      const { ctx, itemA } = await seedScenario(app, 'paid@example.com');
      const report = await topProducts(app, ctx);

      expect(report.basis).toBe('paid');
      expect(report.products).toEqual([
        { sourceItemId: itemA, name: 'Mowing', revenue: '80.00', lineCount: 1 },
        { sourceItemId: null, name: null, revenue: '30.00', lineCount: 1 },
      ]);
    } finally {
      await handle.close();
    }
  });

  it('sent basis includes sent + paid, ranks by revenue, bucket last', async () => {
    const { app, handle } = buildApp();
    try {
      const { ctx, itemA, itemB } = await seedScenario(app, 'sent@example.com');
      const report = await topProducts(app, ctx, 'sent');

      expect(report.basis).toBe('sent');
      expect(report.products).toEqual([
        { sourceItemId: itemB, name: 'Washing', revenue: '200.00', lineCount: 1 },
        { sourceItemId: itemA, name: 'Mowing', revenue: '120.00', lineCount: 2 },
        { sourceItemId: null, name: null, revenue: '30.00', lineCount: 1 },
      ]);
    } finally {
      await handle.close();
    }
  });

  it('keeps the item name after it is archived (history is not lost)', async () => {
    const { app, handle } = buildApp();
    try {
      const { ctx, itemA } = await seedScenario(app, 'arch@example.com');
      const res = await app.request(`/api/items/${itemA}/archive`, {
        method: 'POST',
        headers: { cookie: ctx.cookie, 'x-account-id': ctx.accountId },
      });
      expect(res.status).toBe(200);

      const report = await topProducts(app, ctx, 'sent');
      const row = report.products.find((p) => p.sourceItemId === itemA);
      expect(row?.name).toBe('Mowing');
    } finally {
      await handle.close();
    }
  });

  it('returns an empty list for a company with no sales', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'empty@example.com');
      const ctx = { cookie, ...(await userContext('empty@example.com')) };
      const report = await topProducts(app, ctx);
      expect(report.products).toEqual([]);
    } finally {
      await handle.close();
    }
  });

  it('rejects an unknown basis with 400', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'bad@example.com');
      const { accountId, companyId } = await userContext('bad@example.com');
      const res = await app.request(`/api/companies/${companyId}/top-products?basis=accrual`, {
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(res.status).toBe(400);
    } finally {
      await handle.close();
    }
  });

  it('404s a company in another account', async () => {
    const { app, handle } = buildApp();
    try {
      await signUp(app, 'a@example.com');
      const a = await userContext('a@example.com');
      const bCookie = await signUp(app, 'b@example.com');
      const b = await userContext('b@example.com');
      const res = await app.request(`/api/companies/${a.companyId}/top-products`, {
        headers: { cookie: bCookie, 'x-account-id': b.accountId },
      });
      expect(res.status).toBe(404);
    } finally {
      await handle.close();
    }
  });

  it('caps at the top 25 products by revenue but always keeps the bucket', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'cap@example.com');
      const { accountId, companyId } = await userContext('cap@example.com');
      const ctx: Ctx = { cookie, accountId, companyId };
      const customer = await createCustomer(app, ctx);

      // 27 catalogued items with distinct, descending revenue (item k => 100-k),
      // all on one paid invoice, plus a hand-typed line for the bucket.
      const lines: Line[] = [];
      for (let k = 1; k <= 27; k++) {
        const amount = `${100 - k}.00`;
        const id = await createItem(app, ctx, `Item ${k}`, amount);
        lines.push({
          description: `Item ${k}`,
          quantity: '1',
          unitPrice: amount,
          amount,
          sourceItemId: id,
        });
      }
      lines.push({ description: 'Hand-typed', quantity: '1', unitPrice: '5.00', amount: '5.00' });
      const inv = await createInvoice(app, ctx, customer, 'INV-CAP', lines);
      await markPaid(app, ctx, inv);

      const report = await topProducts(app, ctx);
      // 25 catalogued + the bucket = 26 rows; bucket is last.
      expect(report.products).toHaveLength(26);
      const catalogued = report.products.filter((p) => p.sourceItemId !== null);
      expect(catalogued).toHaveLength(25);
      expect(report.products.at(-1)?.sourceItemId).toBeNull();
      // The two lowest-revenue items (26 => $74, 27 => $73) are dropped.
      const names = catalogued.map((p) => p.name);
      expect(names).toContain('Item 1');
      expect(names).not.toContain('Item 26');
      expect(names).not.toContain('Item 27');
    } finally {
      await handle.close();
    }
  });
});

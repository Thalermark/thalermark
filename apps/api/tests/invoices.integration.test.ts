import {
  auditEvents,
  authUser,
  companies,
  invoiceLineItems,
  invoices,
  journalEntries,
  memberships,
} from '@thalermark/db';
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

async function userContext(email: string): Promise<{
  userId: string;
  accountId: string;
  companyId: string;
}> {
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
  return { userId: user.id, accountId: m.accountId, companyId: company.id };
}

function buildApp(opts: { mailer?: import('../src/lib/mailer.js').Mailer } = {}) {
  // `db` is the non-BYPASSRLS app role so tenant routes run through RLS;
  // `bootstrapDb` + auth use the superuser handle (the RLS-bypass surface).
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const handle = createApiDatabase(appDatabaseUrl());
  const auth = createApiAuth(getTestDb(), { ...testEnv, databaseUrl: url });
  const app = createApp({
    auth,
    db: handle.db,
    bootstrapDb: getTestDb(),
    publicAppUrl: testEnv.publicAppUrl,
    mailer: opts.mailer,
    emailFrom: 'Thalermark <test@thalermark.test>',
  });
  return { app, handle };
}

type CtxApp = { app: ReturnType<typeof createApp>; handle: { close: () => Promise<void> } };

async function createCustomer(
  { app }: CtxApp,
  cookie: string,
  accountId: string,
  companyId: string,
  name = 'Wile E. Coyote',
  email?: string,
): Promise<string> {
  const res = await app.request('/api/customers', {
    method: 'POST',
    headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
    body: JSON.stringify(email ? { companyId, name, email } : { companyId, name }),
  });
  if (res.status !== 201) throw new Error(`customer create failed: ${res.status}`);
  const body = (await res.json()) as { id: string };
  return body.id;
}

function invoiceBody(companyId: string, customerId: string, number = 'INV-001') {
  return {
    companyId,
    customerId,
    number,
    issueDate: '2026-05-23',
    dueDate: '2026-06-22',
    subtotal: '100.00',
    tax: '8.25',
    total: '108.25',
    lineItems: [
      {
        position: 1,
        description: 'Service',
        quantity: '1',
        unitPrice: '100.00',
        amount: '100.00',
      },
    ],
  };
}

describe('POST /api/invoices', () => {
  beforeEach(resetDb);

  it('creates an invoice + line items in one tx and writes audit', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'biller@example.com');
      const { accountId, companyId } = await userContext('biller@example.com');
      const customerId = await createCustomer(ctx, cookie, accountId, companyId);

      const res = await ctx.app.request('/api/invoices', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify(invoiceBody(companyId, customerId)),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string };

      const db = getTestDb();
      const [row] = await db.select().from(invoices).where(eq(invoices.id, body.id));
      expect(row?.number).toBe('INV-001');
      expect(row?.status).toBe('draft');
      expect(row?.total).toBe('108.25');

      const lines = await db
        .select()
        .from(invoiceLineItems)
        .where(eq(invoiceLineItems.invoiceId, body.id));
      expect(lines).toHaveLength(1);
      expect(lines[0]?.amount).toBe('100.00');

      const audits = await db.select().from(auditEvents).where(eq(auditEvents.entityId, body.id));
      expect(audits).toHaveLength(1);
      expect(audits[0]?.entityType).toBe('invoice');
      expect(audits[0]?.action).toBe('create');
    } finally {
      await ctx.handle.close();
    }
  });

  it('returns 409 on a duplicate (companyId, number)', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'dup@example.com');
      const { accountId, companyId } = await userContext('dup@example.com');
      const customerId = await createCustomer(ctx, cookie, accountId, companyId);

      const first = await ctx.app.request('/api/invoices', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify(invoiceBody(companyId, customerId, 'INV-DUP')),
      });
      expect(first.status).toBe(201);

      const second = await ctx.app.request('/api/invoices', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify(invoiceBody(companyId, customerId, 'INV-DUP')),
      });
      expect(second.status).toBe(409);
    } finally {
      await ctx.handle.close();
    }
  });

  it('rejects a customerId from a different account with 404', async () => {
    const ctx = buildApp();
    try {
      const aCookie = await signUp(ctx.app, 'alice-i@example.com');
      const aCtx = await userContext('alice-i@example.com');
      const aCustId = await createCustomer(ctx, aCookie, aCtx.accountId, aCtx.companyId);

      const bCookie = await signUp(ctx.app, 'bob-i@example.com');
      const bCtx = await userContext('bob-i@example.com');

      const res = await ctx.app.request('/api/invoices', {
        method: 'POST',
        headers: {
          cookie: bCookie,
          'x-account-id': bCtx.accountId,
          'content-type': 'application/json',
        },
        body: JSON.stringify(invoiceBody(bCtx.companyId, aCustId)),
      });
      expect(res.status).toBe(404);
    } finally {
      await ctx.handle.close();
    }
  });

  it('rejects a customerId that does not match the requested companyId', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'mismatch@example.com');
      const { accountId, companyId, userId } = await userContext('mismatch@example.com');
      const customerId = await createCustomer(ctx, cookie, accountId, companyId);

      // Insert a second company in the same account (no API yet — direct seed)
      const otherCompanyId = await (async () => {
        const id = (await import('uuid')).v7();
        await getTestDb().insert(companies).values({ id, accountId, name: 'Side Hustle' });
        return id;
      })();

      const res = await ctx.app.request('/api/invoices', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify(invoiceBody(otherCompanyId, customerId)),
      });
      expect(res.status).toBe(400);
      expect(userId).toBeDefined();
    } finally {
      await ctx.handle.close();
    }
  });

  it('rejects a malformed body with 400', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'bad@example.com');
      const { accountId, companyId } = await userContext('bad@example.com');
      const customerId = await createCustomer(ctx, cookie, accountId, companyId);
      const body = invoiceBody(companyId, customerId);
      const res = await ctx.app.request('/api/invoices', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, total: 'free' }),
      });
      expect(res.status).toBe(400);
    } finally {
      await ctx.handle.close();
    }
  });
});

describe('GET /api/invoices and /api/invoices/:id', () => {
  beforeEach(resetDb);

  it('list returns headers; single includes line items', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'reader@example.com');
      const { accountId, companyId } = await userContext('reader@example.com');
      const customerId = await createCustomer(ctx, cookie, accountId, companyId);

      const create = await ctx.app.request('/api/invoices', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify(invoiceBody(companyId, customerId)),
      });
      const { id } = (await create.json()) as { id: string };

      const list = await ctx.app.request('/api/invoices', {
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(list.status).toBe(200);
      const listBody = (await list.json()) as { invoices: { id: string }[] };
      expect(listBody.invoices.map((r) => r.id)).toContain(id);

      const single = await ctx.app.request(`/api/invoices/${id}`, {
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(single.status).toBe(200);
      const singleBody = (await single.json()) as {
        id: string;
        lineItems: { position: number; description: string }[];
      };
      expect(singleBody.id).toBe(id);
      expect(singleBody.lineItems).toHaveLength(1);
      expect(singleBody.lineItems[0]?.description).toBe('Service');
    } finally {
      await ctx.handle.close();
    }
  });

  it('list filters by ?status', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'statuser@example.com');
      const { accountId, companyId } = await userContext('statuser@example.com');
      const customerId = await createCustomer(ctx, cookie, accountId, companyId);
      await ctx.app.request('/api/invoices', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify(invoiceBody(companyId, customerId, 'S-1')),
      });

      const sent = await ctx.app.request('/api/invoices?status=sent', {
        headers: { cookie, 'x-account-id': accountId },
      });
      const sentBody = (await sent.json()) as { invoices: unknown[] };
      expect(sentBody.invoices).toEqual([]);

      const draft = await ctx.app.request('/api/invoices?status=draft', {
        headers: { cookie, 'x-account-id': accountId },
      });
      const draftBody = (await draft.json()) as { invoices: unknown[] };
      expect(draftBody.invoices).toHaveLength(1);
    } finally {
      await ctx.handle.close();
    }
  });

  it('single returns 404 for a cross-tenant id', async () => {
    const ctx = buildApp();
    try {
      const aCookie = await signUp(ctx.app, 'oa@example.com');
      const aCtx = await userContext('oa@example.com');
      const aCust = await createCustomer(ctx, aCookie, aCtx.accountId, aCtx.companyId);
      const create = await ctx.app.request('/api/invoices', {
        method: 'POST',
        headers: {
          cookie: aCookie,
          'x-account-id': aCtx.accountId,
          'content-type': 'application/json',
        },
        body: JSON.stringify(invoiceBody(aCtx.companyId, aCust)),
      });
      const { id } = (await create.json()) as { id: string };

      const bCookie = await signUp(ctx.app, 'ob@example.com');
      const bCtx = await userContext('ob@example.com');
      const res = await ctx.app.request(`/api/invoices/${id}`, {
        headers: { cookie: bCookie, 'x-account-id': bCtx.accountId },
      });
      expect(res.status).toBe(404);
    } finally {
      await ctx.handle.close();
    }
  });
});

describe('GET /api/invoices/next-number', () => {
  beforeEach(async () => resetDb());

  it('returns INV-0001 when the company has no invoices yet', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'first@example.com');
      const { accountId, companyId } = await userContext('first@example.com');
      const res = await ctx.app.request(`/api/invoices/next-number?companyId=${companyId}`, {
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ suggestion: 'INV-0001' });
    } finally {
      await ctx.handle.close();
    }
  });

  it('increments the trailing integer while preserving prefix and width', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'inc@example.com');
      const { accountId, companyId } = await userContext('inc@example.com');
      const customer = await createCustomer(ctx, cookie, accountId, companyId);
      for (const number of ['INV-0041', 'INV-0042']) {
        const post = await ctx.app.request('/api/invoices', {
          method: 'POST',
          headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
          body: JSON.stringify(invoiceBody(companyId, customer, number)),
        });
        expect(post.status).toBe(201);
      }
      const res = await ctx.app.request(`/api/invoices/next-number?companyId=${companyId}`, {
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(await res.json()).toEqual({ suggestion: 'INV-0043' });
    } finally {
      await ctx.handle.close();
    }
  });

  it('honours alternate conventions (bare integer, year prefix)', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'alt@example.com');
      const { accountId, companyId } = await userContext('alt@example.com');
      const customer = await createCustomer(ctx, cookie, accountId, companyId);

      const post1 = await ctx.app.request('/api/invoices', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify(invoiceBody(companyId, customer, '42')),
      });
      expect(post1.status).toBe(201);
      const sug1 = await ctx.app.request(`/api/invoices/next-number?companyId=${companyId}`, {
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(await sug1.json()).toEqual({ suggestion: '43' });

      const post2 = await ctx.app.request('/api/invoices', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify(invoiceBody(companyId, customer, '2026-007')),
      });
      expect(post2.status).toBe(201);
      const sug2 = await ctx.app.request(`/api/invoices/next-number?companyId=${companyId}`, {
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(await sug2.json()).toEqual({ suggestion: '2026-008' });
    } finally {
      await ctx.handle.close();
    }
  });

  it('rejects a missing or malformed companyId with 400', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'bad@example.com');
      const { accountId } = await userContext('bad@example.com');
      for (const q of ['', '?companyId=', '?companyId=not-a-uuid']) {
        const res = await ctx.app.request(`/api/invoices/next-number${q}`, {
          headers: { cookie, 'x-account-id': accountId },
        });
        expect(res.status).toBe(400);
      }
    } finally {
      await ctx.handle.close();
    }
  });

  it('returns 404 for a cross-tenant companyId', async () => {
    const ctx = buildApp();
    try {
      const aCookie = await signUp(ctx.app, 'tenanta@example.com');
      const aCtx = await userContext('tenanta@example.com');
      const bCookie = await signUp(ctx.app, 'tenantb@example.com');
      const bCtx = await userContext('tenantb@example.com');
      const res = await ctx.app.request(`/api/invoices/next-number?companyId=${bCtx.companyId}`, {
        headers: { cookie: aCookie, 'x-account-id': aCtx.accountId },
      });
      expect(res.status).toBe(404);
      // Silence the unused-binding warning — b is set up purely to give us a
      // valid companyId in the other tenant.
      expect(bCookie.length).toBeGreaterThan(0);
    } finally {
      await ctx.handle.close();
    }
  });
});

describe('PATCH /api/invoices/:id', () => {
  beforeEach(resetDb);

  async function seedDraftInvoice(
    ctx: CtxApp,
    email: string,
  ): Promise<{
    cookie: string;
    accountId: string;
    companyId: string;
    customerId: string;
    invoiceId: string;
  }> {
    const cookie = await signUp(ctx.app, email);
    const { accountId, companyId } = await userContext(email);
    const customerId = await createCustomer(ctx, cookie, accountId, companyId);
    const create = await ctx.app.request('/api/invoices', {
      method: 'POST',
      headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
      body: JSON.stringify(invoiceBody(companyId, customerId)),
    });
    if (create.status !== 201) throw new Error(`seed invoice failed: ${create.status}`);
    const { id } = (await create.json()) as { id: string };
    return { cookie, accountId, companyId, customerId, invoiceId: id };
  }

  it('replaces header + line items in one tx and writes an update audit', async () => {
    const ctx = buildApp();
    try {
      const { cookie, accountId, companyId, customerId, invoiceId } = await seedDraftInvoice(
        ctx,
        'invedit@example.com',
      );

      const newBody = {
        customerId,
        number: 'INV-002',
        issueDate: '2026-06-01',
        dueDate: '2026-07-01',
        subtotal: '220.00',
        tax: '17.00',
        total: '237.00',
        notes: 'Revised scope',
        lineItems: [
          {
            position: 1,
            description: 'Power washing — front + side',
            quantity: '3',
            unitPrice: '60.00',
            amount: '180.00',
          },
          {
            position: 2,
            description: 'Travel',
            quantity: '1',
            unitPrice: '40.00',
            amount: '40.00',
          },
        ],
      };
      const res = await ctx.app.request(`/api/invoices/${invoiceId}`, {
        method: 'PATCH',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify(newBody),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        number: string;
        total: string;
        lineItems: { description: string }[];
      };
      expect(body.number).toBe('INV-002');
      expect(body.total).toBe('237.00');
      expect(body.lineItems.map((l) => l.description).sort()).toEqual(
        ['Power washing — front + side', 'Travel'].sort(),
      );

      const db = getTestDb();
      const lines = await db
        .select()
        .from(invoiceLineItems)
        .where(eq(invoiceLineItems.invoiceId, invoiceId));
      expect(lines).toHaveLength(2);

      const audits = await db.select().from(auditEvents).where(eq(auditEvents.entityId, invoiceId));
      expect(audits.map((a) => a.action).sort()).toEqual(['create', 'update']);
      const update = audits.find((a) => a.action === 'update');
      expect(update?.before).toMatchObject({ number: 'INV-001' });
      expect(update?.after).toMatchObject({ number: 'INV-002' });
      expect(companyId).toBeDefined();
    } finally {
      await ctx.handle.close();
    }
  });

  it('rejects edits on a sent invoice with 409 not_editable', async () => {
    const ctx = buildApp();
    try {
      const { cookie, accountId, customerId, invoiceId } = await seedDraftInvoice(
        ctx,
        'locked@example.com',
      );
      const sentRes = await ctx.app.request(`/api/invoices/${invoiceId}/mark-sent`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(sentRes.status).toBe(200);

      const res = await ctx.app.request(`/api/invoices/${invoiceId}`, {
        method: 'PATCH',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({
          customerId,
          number: 'INV-002',
          issueDate: '2026-06-01',
          dueDate: '2026-07-01',
          subtotal: '100.00',
          tax: '0',
          total: '100.00',
          lineItems: [
            { position: 1, description: 'X', quantity: '1', unitPrice: '100.00', amount: '100.00' },
          ],
        }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; status: string };
      expect(body.error).toBe('not_editable');
      expect(body.status).toBe('sent');
    } finally {
      await ctx.handle.close();
    }
  });

  it('returns 409 if the new number collides with another invoice in the same company', async () => {
    const ctx = buildApp();
    try {
      const { cookie, accountId, companyId, customerId, invoiceId } = await seedDraftInvoice(
        ctx,
        'collide@example.com',
      );
      // Create a second invoice with a different number to collide against
      const second = await ctx.app.request('/api/invoices', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify(invoiceBody(companyId, customerId, 'INV-002')),
      });
      expect(second.status).toBe(201);

      const res = await ctx.app.request(`/api/invoices/${invoiceId}`, {
        method: 'PATCH',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({
          ...invoiceBody(companyId, customerId, 'INV-002'),
          companyId: undefined,
        }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('invoice_number_taken');
    } finally {
      await ctx.handle.close();
    }
  });

  it('rejects a customerId from a different company in the same account with 400', async () => {
    const ctx = buildApp();
    try {
      const { cookie, accountId, companyId, invoiceId } = await seedDraftInvoice(
        ctx,
        'crosscompany@example.com',
      );
      // Seed a second company + a customer over there
      const otherCompanyId = (await import('uuid')).v7();
      await getTestDb()
        .insert(companies)
        .values({ id: otherCompanyId, accountId, name: 'Side Hustle' });
      const otherCustomerId = await createCustomer(
        ctx,
        cookie,
        accountId,
        otherCompanyId,
        'Other Co Customer',
      );
      expect(companyId).not.toBe(otherCompanyId);

      const res = await ctx.app.request(`/api/invoices/${invoiceId}`, {
        method: 'PATCH',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({
          customerId: otherCustomerId,
          number: 'INV-001',
          issueDate: '2026-05-23',
          dueDate: '2026-06-22',
          subtotal: '100.00',
          tax: '0',
          total: '100.00',
          lineItems: [
            { position: 1, description: 'Y', quantity: '1', unitPrice: '100.00', amount: '100.00' },
          ],
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('customer_company_mismatch');
    } finally {
      await ctx.handle.close();
    }
  });

  it('returns 404 for a cross-tenant invoice id', async () => {
    const ctx = buildApp();
    try {
      const a = await seedDraftInvoice(ctx, 'inv-a@example.com');
      const bCookie = await signUp(ctx.app, 'inv-b@example.com');
      const bCtx = await userContext('inv-b@example.com');
      const res = await ctx.app.request(`/api/invoices/${a.invoiceId}`, {
        method: 'PATCH',
        headers: {
          cookie: bCookie,
          'x-account-id': bCtx.accountId,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          customerId: a.customerId,
          number: 'INV-XX',
          issueDate: '2026-05-23',
          dueDate: '2026-06-22',
          subtotal: '1.00',
          tax: '0',
          total: '1.00',
          lineItems: [
            { position: 1, description: 'Z', quantity: '1', unitPrice: '1.00', amount: '1.00' },
          ],
        }),
      });
      expect(res.status).toBe(404);
    } finally {
      await ctx.handle.close();
    }
  });
});

describe('invoice status transitions', () => {
  beforeEach(resetDb);

  async function seedDraftInvoice(
    ctx: CtxApp,
    email: string,
  ): Promise<{ cookie: string; accountId: string; invoiceId: string }> {
    const cookie = await signUp(ctx.app, email);
    const { accountId, companyId } = await userContext(email);
    const customerId = await createCustomer(ctx, cookie, accountId, companyId);
    const create = await ctx.app.request('/api/invoices', {
      method: 'POST',
      headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
      body: JSON.stringify(invoiceBody(companyId, customerId)),
    });
    if (create.status !== 201) throw new Error(`seed invoice failed: ${create.status}`);
    const { id } = (await create.json()) as { id: string };
    return { cookie, accountId, invoiceId: id };
  }

  it('mark-sent flips draft → sent and stamps sent_at + writes audit', async () => {
    const ctx = buildApp();
    try {
      const { cookie, accountId, invoiceId } = await seedDraftInvoice(ctx, 'send@example.com');
      const res = await ctx.app.request(`/api/invoices/${invoiceId}/mark-sent`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; sentAt: string | null };
      expect(body.status).toBe('sent');
      expect(body.sentAt).not.toBeNull();

      const db = getTestDb();
      const [row] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
      expect(row?.status).toBe('sent');
      expect(row?.sentAt).not.toBeNull();
      expect(row?.paidAt).toBeNull();
      expect(row?.voidedAt).toBeNull();

      const audits = await db.select().from(auditEvents).where(eq(auditEvents.entityId, invoiceId));
      expect(audits.map((a) => a.action).sort()).toEqual(['create', 'mark-sent']);
    } finally {
      await ctx.handle.close();
    }
  });

  it('mark-paid from draft skips sent_at; from sent fills both', async () => {
    const ctx = buildApp();
    try {
      const { cookie, accountId, invoiceId } = await seedDraftInvoice(ctx, 'paid@example.com');
      const direct = await ctx.app.request(`/api/invoices/${invoiceId}/mark-paid`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'cash' }),
      });
      expect(direct.status).toBe(200);
      const db = getTestDb();
      const [paidFromDraft] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
      expect(paidFromDraft?.status).toBe('paid');
      expect(paidFromDraft?.paidAt).not.toBeNull();
      expect(paidFromDraft?.sentAt).toBeNull();
      // The recorded payment method persists from the mark-paid body.
      expect(paidFromDraft?.paymentMethod).toBe('cash');

      const second = await seedDraftInvoice(ctx, 'paid2@example.com');
      await ctx.app.request(`/api/invoices/${second.invoiceId}/mark-sent`, {
        method: 'POST',
        headers: { cookie: second.cookie, 'x-account-id': second.accountId },
      });
      const markPaid = await ctx.app.request(`/api/invoices/${second.invoiceId}/mark-paid`, {
        method: 'POST',
        headers: {
          cookie: second.cookie,
          'x-account-id': second.accountId,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ method: 'cash' }),
      });
      expect(markPaid.status).toBe(200);
      const [paidFromSent] = await db
        .select()
        .from(invoices)
        .where(eq(invoices.id, second.invoiceId));
      expect(paidFromSent?.status).toBe('paid');
      expect(paidFromSent?.sentAt).not.toBeNull();
      expect(paidFromSent?.paidAt).not.toBeNull();
    } finally {
      await ctx.handle.close();
    }
  });

  it('backdates paidAt to the provided paidOn date', async () => {
    const ctx = buildApp();
    try {
      const { cookie, accountId, invoiceId } = await seedDraftInvoice(ctx, 'backdate@example.com');
      const res = await ctx.app.request(`/api/invoices/${invoiceId}/mark-paid`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'check', reference: '1042', paidOn: '2026-05-20' }),
      });
      expect(res.status).toBe(200);
      const db = getTestDb();
      const [row] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
      expect(row?.status).toBe('paid');
      expect(row?.paymentMethod).toBe('check');
      expect(row?.paymentReference).toBe('1042');
      // paidAt stamped to the backdated date (midnight UTC), not the record time.
      expect(row?.paidAt?.toISOString().slice(0, 10)).toBe('2026-05-20');
    } finally {
      await ctx.handle.close();
    }
  });

  it('edit-payment updates method/reference with no ledger correction', async () => {
    const ctx = buildApp();
    try {
      const { cookie, accountId, invoiceId } = await seedDraftInvoice(ctx, 'editm@example.com');
      const h = { cookie, 'x-account-id': accountId, 'content-type': 'application/json' };
      await ctx.app.request(`/api/invoices/${invoiceId}/mark-paid`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ method: 'cash' }),
      });
      const db = getTestDb();
      const before = await db
        .select()
        .from(journalEntries)
        .where(eq(journalEntries.sourceEntityId, invoiceId));
      const res = await ctx.app.request(`/api/invoices/${invoiceId}/edit-payment`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ method: 'check', reference: '7788' }),
      });
      expect(res.status).toBe(200);
      const [row] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
      expect(row?.paymentMethod).toBe('check');
      expect(row?.paymentReference).toBe('7788');
      const after = await db
        .select()
        .from(journalEntries)
        .where(eq(journalEntries.sourceEntityId, invoiceId));
      // No date change → no reversal/re-post.
      expect(after.length).toBe(before.length);
    } finally {
      await ctx.handle.close();
    }
  });

  it('edit-payment moves paidAt and posts a reversal + re-post when the date changes', async () => {
    const ctx = buildApp();
    try {
      const { cookie, accountId, invoiceId } = await seedDraftInvoice(ctx, 'editd@example.com');
      const h = { cookie, 'x-account-id': accountId, 'content-type': 'application/json' };
      await ctx.app.request(`/api/invoices/${invoiceId}/mark-paid`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ method: 'cash', paidOn: '2026-05-10' }),
      });
      const db = getTestDb();
      const before = await db
        .select()
        .from(journalEntries)
        .where(eq(journalEntries.sourceEntityId, invoiceId));
      const res = await ctx.app.request(`/api/invoices/${invoiceId}/edit-payment`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ method: 'cash', paidOn: '2026-06-01' }),
      });
      expect(res.status).toBe(200);
      const [row] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
      expect(row?.paidAt?.toISOString().slice(0, 10)).toBe('2026-06-01');
      const after = await db
        .select()
        .from(journalEntries)
        .where(eq(journalEntries.sourceEntityId, invoiceId));
      // Append-only correction: one reversal + one re-post.
      expect(after.length).toBe(before.length + 2);
    } finally {
      await ctx.handle.close();
    }
  });

  it('rejects edit-payment on a non-paid invoice with 409', async () => {
    const ctx = buildApp();
    try {
      const { cookie, accountId, invoiceId } = await seedDraftInvoice(ctx, 'editx@example.com');
      const res = await ctx.app.request(`/api/invoices/${invoiceId}/edit-payment`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'cash' }),
      });
      expect(res.status).toBe(409);
      expect((await res.json()) as { error: string }).toMatchObject({ error: 'not_paid' });
    } finally {
      await ctx.handle.close();
    }
  });

  it('void from draft stamps voided_at', async () => {
    const ctx = buildApp();
    try {
      const { cookie, accountId, invoiceId } = await seedDraftInvoice(ctx, 'void@example.com');
      const res = await ctx.app.request(`/api/invoices/${invoiceId}/void`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(res.status).toBe(200);
      const db = getTestDb();
      const [row] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
      expect(row?.status).toBe('voided');
      expect(row?.voidedAt).not.toBeNull();
    } finally {
      await ctx.handle.close();
    }
  });

  it('rejects mark-paid on a voided invoice with 409', async () => {
    const ctx = buildApp();
    try {
      const { cookie, accountId, invoiceId } = await seedDraftInvoice(ctx, 'terminal@example.com');
      const voidRes = await ctx.app.request(`/api/invoices/${invoiceId}/void`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(voidRes.status).toBe(200);
      const replay = await ctx.app.request(`/api/invoices/${invoiceId}/mark-paid`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'cash' }),
      });
      expect(replay.status).toBe(409);
      const body = (await replay.json()) as { error: string; from: string; to: string };
      expect(body.error).toBe('invalid_transition');
      expect(body.from).toBe('voided');
      expect(body.to).toBe('paid');
    } finally {
      await ctx.handle.close();
    }
  });

  it('rejects mark-sent on an already-sent invoice with 409', async () => {
    const ctx = buildApp();
    try {
      const { cookie, accountId, invoiceId } = await seedDraftInvoice(ctx, 'resend@example.com');
      await ctx.app.request(`/api/invoices/${invoiceId}/mark-sent`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      const replay = await ctx.app.request(`/api/invoices/${invoiceId}/mark-sent`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(replay.status).toBe(409);
    } finally {
      await ctx.handle.close();
    }
  });

  it('returns 404 for a cross-tenant invoice id', async () => {
    const ctx = buildApp();
    try {
      const a = await seedDraftInvoice(ctx, 'tx-a@example.com');
      const bCookie = await signUp(ctx.app, 'tx-b@example.com');
      const bCtx = await userContext('tx-b@example.com');
      const res = await ctx.app.request(`/api/invoices/${a.invoiceId}/mark-sent`, {
        method: 'POST',
        headers: { cookie: bCookie, 'x-account-id': bCtx.accountId },
      });
      expect(res.status).toBe(404);
    } finally {
      await ctx.handle.close();
    }
  });
});

describe('public invoice view', () => {
  beforeEach(resetDb);

  async function seedDraftInvoice(
    ctx: CtxApp,
    email: string,
  ): Promise<{ cookie: string; accountId: string; invoiceId: string }> {
    const cookie = await signUp(ctx.app, email);
    const { accountId, companyId } = await userContext(email);
    const customerId = await createCustomer(ctx, cookie, accountId, companyId);
    const create = await ctx.app.request('/api/invoices', {
      method: 'POST',
      headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
      body: JSON.stringify(invoiceBody(companyId, customerId)),
    });
    if (create.status !== 201) throw new Error(`seed invoice failed: ${create.status}`);
    const { id } = (await create.json()) as { id: string };
    return { cookie, accountId, invoiceId: id };
  }

  it('mark-sent mints a public_token; other transitions leave it alone', async () => {
    const ctx = buildApp();
    try {
      const { cookie, accountId, invoiceId } = await seedDraftInvoice(ctx, 'pub-mint@example.com');
      const db = getTestDb();

      const [draftRow] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
      expect(draftRow?.publicToken).toBeNull();

      const sent = await ctx.app.request(`/api/invoices/${invoiceId}/mark-sent`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(sent.status).toBe(200);
      const [sentRow] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
      expect(sentRow?.publicToken).toBeTypeOf('string');
      expect(sentRow?.publicToken?.length).toBe(64);
      const mintedToken = sentRow?.publicToken;

      const paid = await ctx.app.request(`/api/invoices/${invoiceId}/mark-paid`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'cash' }),
      });
      expect(paid.status).toBe(200);
      const [paidRow] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
      expect(paidRow?.publicToken).toBe(mintedToken);
    } finally {
      await ctx.handle.close();
    }
  });

  it('GET /api/public/invoices/:token returns the rendered invoice without a session', async () => {
    const ctx = buildApp();
    try {
      const { cookie, accountId, invoiceId } = await seedDraftInvoice(ctx, 'pub-view@example.com');
      await ctx.app.request(`/api/invoices/${invoiceId}/mark-sent`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      const db = getTestDb();
      const [row] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
      const token = row?.publicToken;
      expect(token).toBeTypeOf('string');

      // Unauthed — no cookie, no x-account-id header.
      const res = await ctx.app.request(`/api/public/invoices/${token}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        number: string;
        status: string;
        companyName: string | null;
        customerName: string | null;
        lineItems: unknown[];
      };
      expect(body.number).toBe('INV-001');
      expect(body.status).toBe('sent');
      expect(body.customerName).toBe('Wile E. Coyote');
      expect(body.companyName).toBe('pub-view@example.com');
      expect(body.lineItems).toHaveLength(1);
    } finally {
      await ctx.handle.close();
    }
  });

  it('from-block contact fields are gated per-invoice by the show flags', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'from-flags@example.com');
      const { accountId, companyId } = await userContext('from-flags@example.com');
      const customerId = await createCustomer(ctx, cookie, accountId, companyId);

      // Fill the company's contact identity.
      const patched = await ctx.app.request(`/api/companies/${companyId}`, {
        method: 'PATCH',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({
          businessAddress: '1 Test Way\nAustin, TX',
          businessPhone: '+1 512 555 0100',
          businessEmail: 'hello@acme.test',
        }),
      });
      expect(patched.status).toBe(200);

      // Invoice shows address + email but hides phone (overriding defaults).
      const create = await ctx.app.request('/api/invoices', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({
          ...invoiceBody(companyId, customerId),
          showAddress: true,
          showPhone: false,
          showEmail: true,
        }),
      });
      expect(create.status).toBe(201);
      const { id: invoiceId } = (await create.json()) as { id: string };

      await ctx.app.request(`/api/invoices/${invoiceId}/mark-sent`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      const db = getTestDb();
      const [row] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));

      const res = await ctx.app.request(`/api/public/invoices/${row?.publicToken}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        companyAddress: string | null;
        companyPhone: string | null;
        companyEmail: string | null;
      };
      expect(body.companyAddress).toBe('1 Test Way\nAustin, TX');
      expect(body.companyPhone).toBeNull(); // hidden by showPhone=false
      expect(body.companyEmail).toBe('hello@acme.test');
    } finally {
      await ctx.handle.close();
    }
  });

  it('new invoices seed their show flags from the company defaults when omitted', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'from-seed@example.com');
      const { accountId, companyId } = await userContext('from-seed@example.com');
      const customerId = await createCustomer(ctx, cookie, accountId, companyId);

      // Turn the email default off at the company level.
      const patched = await ctx.app.request(`/api/companies/${companyId}`, {
        method: 'PATCH',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({ showEmailOnInvoice: false }),
      });
      expect(patched.status).toBe(200);

      // Create without sending any flags — the server seeds from the company.
      const create = await ctx.app.request('/api/invoices', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify(invoiceBody(companyId, customerId)),
      });
      expect(create.status).toBe(201);
      const { id } = (await create.json()) as { id: string };

      const db = getTestDb();
      const [row] = await db.select().from(invoices).where(eq(invoices.id, id));
      expect(row?.showAddress).toBe(true);
      expect(row?.showPhone).toBe(true);
      expect(row?.showEmail).toBe(false); // inherited the company default
    } finally {
      await ctx.handle.close();
    }
  });

  it('returns 404 for an unknown token', async () => {
    const ctx = buildApp();
    try {
      const res = await ctx.app.request('/api/public/invoices/not-a-real-token');
      expect(res.status).toBe(404);
    } finally {
      await ctx.handle.close();
    }
  });

  it('draft invoices have no token and are not publicly reachable', async () => {
    const ctx = buildApp();
    try {
      const { invoiceId } = await seedDraftInvoice(ctx, 'pub-draft@example.com');
      const db = getTestDb();
      const [row] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
      expect(row?.publicToken).toBeNull();
      // No token to address the row by, so the only way to reach it via the
      // public route is to guess — covered by the unknown-token 404 above.
      // This assertion captures the invariant: drafts never get a token,
      // even by accident.
    } finally {
      await ctx.handle.close();
    }
  });
});

describe('POST /api/invoices/:id/send', () => {
  beforeEach(resetDb);

  // Recorder mailer: capture .send() calls instead of hitting the wire. Each
  // appends to `sent`; the throws flag flips the next send into a failure to
  // exercise the 502 path without coupling to Resend or fetch internals.
  type SentMail = {
    to: string;
    subject: string;
    html: string;
    text: string;
    from?: string;
    replyTo?: string;
  };
  function makeRecorder(opts: { throws?: boolean } = {}) {
    const sent: SentMail[] = [];
    return {
      sent,
      mailer: {
        async send(msg: SentMail) {
          if (opts.throws) throw new Error('mailer_down');
          sent.push(msg);
        },
      },
    };
  }

  async function seedDraftInvoiceWithEmail(
    ctx: CtxApp,
    signupEmail: string,
    customerEmail: string | null = 'wile@acme.test',
  ): Promise<{ cookie: string; accountId: string; invoiceId: string; customerId: string }> {
    const cookie = await signUp(ctx.app, signupEmail);
    const { accountId, companyId } = await userContext(signupEmail);
    const customerId = await createCustomer(
      ctx,
      cookie,
      accountId,
      companyId,
      'Wile E. Coyote',
      customerEmail ?? undefined,
    );
    const create = await ctx.app.request('/api/invoices', {
      method: 'POST',
      headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
      body: JSON.stringify(invoiceBody(companyId, customerId)),
    });
    if (create.status !== 201) throw new Error(`seed invoice failed: ${create.status}`);
    const { id } = (await create.json()) as { id: string };
    return { cookie, accountId, invoiceId: id, customerId };
  }

  it('first send transitions draft → sent, emails the customer, writes both audit rows', async () => {
    const rec = makeRecorder();
    const ctx = buildApp({ mailer: rec.mailer });
    try {
      const { cookie, accountId, invoiceId } = await seedDraftInvoiceWithEmail(
        ctx,
        'sender@example.com',
      );
      const res = await ctx.app.request(`/api/invoices/${invoiceId}/send`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        sentAt: string | null;
        publicToken: string | null;
        sentTo: string;
      };
      expect(body.status).toBe('sent');
      expect(body.sentAt).not.toBeNull();
      expect(body.publicToken).toBeTypeOf('string');
      expect(body.sentTo).toBe('wile@acme.test');

      expect(rec.sent).toHaveLength(1);
      const mail = rec.sent[0];
      expect(mail?.to).toBe('wile@acme.test');
      expect(mail?.subject).toMatch(/Invoice INV-001/);
      // Body links to the public view using the token the API just minted.
      expect(mail?.html).toContain(`/i/${body.publicToken}`);
      expect(mail?.text).toContain(`/i/${body.publicToken}`);
      // From keeps the verified envelope address (display name swapped to the
      // company); no reply-to until the company sets one.
      expect(mail?.from).toMatch(/<test@thalermark\.test>$/);
      expect(mail?.replyTo).toBeUndefined();

      const db = getTestDb();
      const audits = await db.select().from(auditEvents).where(eq(auditEvents.entityId, invoiceId));
      expect(audits.map((a) => a.action).sort()).toEqual(['create', 'email-sent', 'mark-sent']);
    } finally {
      await ctx.handle.close();
    }
  });

  it('carries the company reply-to and a company-named From once reply_to_email is set', async () => {
    const rec = makeRecorder();
    const ctx = buildApp({ mailer: rec.mailer });
    try {
      const { cookie, accountId, invoiceId } = await seedDraftInvoiceWithEmail(
        ctx,
        'replyto@example.com',
      );
      const { companyId } = await userContext('replyto@example.com');

      const patch = await ctx.app.request(`/api/companies/${companyId}`, {
        method: 'PATCH',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({ replyToEmail: 'hello@sunnylawncare.test' }),
      });
      expect(patch.status).toBe(200);

      const res = await ctx.app.request(`/api/invoices/${invoiceId}/send`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(200);

      const mail = rec.sent[0];
      expect(mail?.replyTo).toBe('hello@sunnylawncare.test');
      // Display name swapped (quoted), envelope address still the verified one.
      expect(mail?.from).toMatch(/^".+" <test@thalermark\.test>$/);
    } finally {
      await ctx.handle.close();
    }
  });

  it('resend on a sent invoice emails again without transitioning or re-minting the token', async () => {
    const rec = makeRecorder();
    const ctx = buildApp({ mailer: rec.mailer });
    try {
      const { cookie, accountId, invoiceId } = await seedDraftInvoiceWithEmail(
        ctx,
        'resend@example.com',
      );
      const first = await ctx.app.request(`/api/invoices/${invoiceId}/send`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(first.status).toBe(200);
      const db = getTestDb();
      const [afterFirst] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
      const firstSentAt = afterFirst?.sentAt;
      const mintedToken = afterFirst?.publicToken;

      const second = await ctx.app.request(`/api/invoices/${invoiceId}/send`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(second.status).toBe(200);
      expect(rec.sent).toHaveLength(2);

      const [afterSecond] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
      expect(afterSecond?.status).toBe('sent');
      expect(afterSecond?.publicToken).toBe(mintedToken);
      expect(afterSecond?.sentAt?.toISOString()).toBe(firstSentAt?.toISOString());

      // Two email-sent rows, still only one mark-sent.
      const audits = await db.select().from(auditEvents).where(eq(auditEvents.entityId, invoiceId));
      expect(audits.filter((a) => a.action === 'mark-sent')).toHaveLength(1);
      expect(audits.filter((a) => a.action === 'email-sent')).toHaveLength(2);
    } finally {
      await ctx.handle.close();
    }
  });

  it('sends to the body override when provided', async () => {
    const rec = makeRecorder();
    const ctx = buildApp({ mailer: rec.mailer });
    try {
      const { cookie, accountId, invoiceId } = await seedDraftInvoiceWithEmail(
        ctx,
        'override@example.com',
      );
      const res = await ctx.app.request(`/api/invoices/${invoiceId}/send`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({ to: 'bookkeeper@acme.test' }),
      });
      expect(res.status).toBe(200);
      expect(rec.sent).toHaveLength(1);
      expect(rec.sent[0]?.to).toBe('bookkeeper@acme.test');
    } finally {
      await ctx.handle.close();
    }
  });

  it('returns 400 invalid_recipient when neither override nor customer email is present', async () => {
    const rec = makeRecorder();
    const ctx = buildApp({ mailer: rec.mailer });
    try {
      const { cookie, accountId, invoiceId } = await seedDraftInvoiceWithEmail(
        ctx,
        'no-email@example.com',
        null, // customer has no email
      );
      const res = await ctx.app.request(`/api/invoices/${invoiceId}/send`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('invalid_recipient');
      expect(rec.sent).toHaveLength(0);

      // Draft stays draft on a 400 — no transition, no audit row.
      const db = getTestDb();
      const [row] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
      expect(row?.status).toBe('draft');
      expect(row?.sentAt).toBeNull();
    } finally {
      await ctx.handle.close();
    }
  });

  it('rejects send on a paid invoice with 409 invalid_transition', async () => {
    const rec = makeRecorder();
    const ctx = buildApp({ mailer: rec.mailer });
    try {
      const { cookie, accountId, invoiceId } = await seedDraftInvoiceWithEmail(
        ctx,
        'paid-send@example.com',
      );
      await ctx.app.request(`/api/invoices/${invoiceId}/mark-paid`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'cash' }),
      });
      const res = await ctx.app.request(`/api/invoices/${invoiceId}/send`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; from: string };
      expect(body.error).toBe('invalid_transition');
      expect(body.from).toBe('paid');
      expect(rec.sent).toHaveLength(0);
    } finally {
      await ctx.handle.close();
    }
  });

  it('mailer failure surfaces 502 BUT the status transition still commits', async () => {
    const rec = makeRecorder({ throws: true });
    const ctx = buildApp({ mailer: rec.mailer });
    try {
      const { cookie, accountId, invoiceId } = await seedDraftInvoiceWithEmail(
        ctx,
        'bad-mailer@example.com',
      );
      const res = await ctx.app.request(`/api/invoices/${invoiceId}/send`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('email_failed');

      // Status flip + token mint + mark-sent audit row all commit; only the
      // email-sent audit row is absent so the user can retry the send.
      const db = getTestDb();
      const [row] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
      expect(row?.status).toBe('sent');
      expect(row?.sentAt).not.toBeNull();
      expect(row?.publicToken).toBeTypeOf('string');

      const audits = await db.select().from(auditEvents).where(eq(auditEvents.entityId, invoiceId));
      expect(audits.map((a) => a.action).sort()).toEqual(['create', 'mark-sent']);
    } finally {
      await ctx.handle.close();
    }
  });

  it('returns 500 email_not_configured when no mailer is wired in', async () => {
    const ctx = buildApp(); // no mailer
    try {
      const { cookie, accountId, invoiceId } = await seedDraftInvoiceWithEmail(
        ctx,
        'no-mailer@example.com',
      );
      const res = await ctx.app.request(`/api/invoices/${invoiceId}/send`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('email_not_configured');
    } finally {
      await ctx.handle.close();
    }
  });
});

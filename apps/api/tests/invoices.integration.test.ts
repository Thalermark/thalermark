import {
  auditEvents,
  authUser,
  chartOfAccounts,
  companies,
  invoiceLineItems,
  invoices,
  journalEntries,
  journalLines,
  memberships,
} from '@thalermark/db';
import { and, eq, sql } from 'drizzle-orm';
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

async function createContact(
  { app }: CtxApp,
  cookie: string,
  accountId: string,
  companyId: string,
  name = 'Wile E. Coyote',
  email?: string,
): Promise<string> {
  const res = await app.request('/api/contacts', {
    method: 'POST',
    headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
    body: JSON.stringify(email ? { companyId, name, email } : { companyId, name }),
  });
  if (res.status !== 201) throw new Error(`customer create failed: ${res.status}`);
  const body = (await res.json()) as { id: string };
  return body.id;
}

function invoiceBody(companyId: string, contactId: string, number = 'INV-001') {
  return {
    companyId,
    contactId,
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
      const contactId = await createContact(ctx, cookie, accountId, companyId);

      const res = await ctx.app.request('/api/invoices', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify(invoiceBody(companyId, contactId)),
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

  it('stores a 4dp unit price that reaches an agreed round total ($650 over 7)', async () => {
    // TMC-134: a 2dp unit price can't make 7 units total $650 (7×92.85=649.95,
    // 7×92.86=650.02). A 4dp unit price (92.8571 × 7 = 650.00) can, and the API
    // stores unit price + amount as-sent — so the invoice total, and thus the
    // Stripe charge and the ledger, all become exactly $650.
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'daysitter@example.com');
      const { accountId, companyId } = await userContext('daysitter@example.com');
      const contactId = await createContact(ctx, cookie, accountId, companyId);

      const res = await ctx.app.request('/api/invoices', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({
          companyId,
          contactId,
          number: 'INV-650',
          issueDate: '2026-07-14',
          dueDate: '2026-08-13',
          subtotal: '650.00',
          total: '650.00',
          lineItems: [
            {
              position: 1,
              description: 'Dog sitting — 7 days',
              quantity: '7',
              unitPrice: '92.8571',
              amount: '650.00',
            },
          ],
        }),
      });
      expect(res.status).toBe(201);
      const { id } = (await res.json()) as { id: string };

      const db = getTestDb();
      const [inv] = await db.select().from(invoices).where(eq(invoices.id, id));
      expect(inv?.total).toBe('650.00');
      const [line] = await db
        .select()
        .from(invoiceLineItems)
        .where(eq(invoiceLineItems.invoiceId, id));
      // The 4dp unit price is preserved (numeric(15,4)); the amount is exactly $650.
      expect(line?.unitPrice).toBe('92.8571');
      expect(line?.amount).toBe('650.00');
    } finally {
      await ctx.handle.close();
    }
  });

  it('returns 409 on a duplicate (companyId, number)', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'dup@example.com');
      const { accountId, companyId } = await userContext('dup@example.com');
      const contactId = await createContact(ctx, cookie, accountId, companyId);

      const first = await ctx.app.request('/api/invoices', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify(invoiceBody(companyId, contactId, 'INV-DUP')),
      });
      expect(first.status).toBe(201);

      const second = await ctx.app.request('/api/invoices', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify(invoiceBody(companyId, contactId, 'INV-DUP')),
      });
      expect(second.status).toBe(409);
    } finally {
      await ctx.handle.close();
    }
  });

  it('rejects a contactId from a different account with 404', async () => {
    const ctx = buildApp();
    try {
      const aCookie = await signUp(ctx.app, 'alice-i@example.com');
      const aCtx = await userContext('alice-i@example.com');
      const aCustId = await createContact(ctx, aCookie, aCtx.accountId, aCtx.companyId);

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

  it('rejects a contactId that does not match the requested companyId', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'mismatch@example.com');
      const { accountId, companyId, userId } = await userContext('mismatch@example.com');
      const contactId = await createContact(ctx, cookie, accountId, companyId);

      // Insert a second company in the same account (no API yet — direct seed)
      const otherCompanyId = await (async () => {
        const id = (await import('uuid')).v7();
        await getTestDb().insert(companies).values({ id, accountId, name: 'Side Hustle' });
        return id;
      })();

      const res = await ctx.app.request('/api/invoices', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify(invoiceBody(otherCompanyId, contactId)),
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
      const contactId = await createContact(ctx, cookie, accountId, companyId);
      const body = invoiceBody(companyId, contactId);
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
      const contactId = await createContact(ctx, cookie, accountId, companyId);

      const create = await ctx.app.request('/api/invoices', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify(invoiceBody(companyId, contactId)),
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
      const contactId = await createContact(ctx, cookie, accountId, companyId);
      await ctx.app.request('/api/invoices', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify(invoiceBody(companyId, contactId, 'S-1')),
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
      const aCust = await createContact(ctx, aCookie, aCtx.accountId, aCtx.companyId);
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
      const customer = await createContact(ctx, cookie, accountId, companyId);
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
      const customer = await createContact(ctx, cookie, accountId, companyId);

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
    contactId: string;
    invoiceId: string;
  }> {
    const cookie = await signUp(ctx.app, email);
    const { accountId, companyId } = await userContext(email);
    const contactId = await createContact(ctx, cookie, accountId, companyId);
    const create = await ctx.app.request('/api/invoices', {
      method: 'POST',
      headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
      body: JSON.stringify(invoiceBody(companyId, contactId)),
    });
    if (create.status !== 201) throw new Error(`seed invoice failed: ${create.status}`);
    const { id } = (await create.json()) as { id: string };
    return { cookie, accountId, companyId, contactId, invoiceId: id };
  }

  it('replaces header + line items in one tx and writes an update audit', async () => {
    const ctx = buildApp();
    try {
      const { cookie, accountId, companyId, contactId, invoiceId } = await seedDraftInvoice(
        ctx,
        'invedit@example.com',
      );

      const newBody = {
        contactId,
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
      const { cookie, accountId, contactId, invoiceId } = await seedDraftInvoice(
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
          contactId,
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
      const { cookie, accountId, companyId, contactId, invoiceId } = await seedDraftInvoice(
        ctx,
        'collide@example.com',
      );
      // Create a second invoice with a different number to collide against
      const second = await ctx.app.request('/api/invoices', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify(invoiceBody(companyId, contactId, 'INV-002')),
      });
      expect(second.status).toBe(201);

      const res = await ctx.app.request(`/api/invoices/${invoiceId}`, {
        method: 'PATCH',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({
          ...invoiceBody(companyId, contactId, 'INV-002'),
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

  it('rejects a contactId from a different company in the same account with 400', async () => {
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
      const otherCustomerId = await createContact(
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
          contactId: otherCustomerId,
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
          contactId: a.contactId,
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
    const contactId = await createContact(ctx, cookie, accountId, companyId);
    const create = await ctx.app.request('/api/invoices', {
      method: 'POST',
      headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
      body: JSON.stringify(invoiceBody(companyId, contactId)),
    });
    if (create.status !== 201) throw new Error(`seed invoice failed: ${create.status}`);
    const { id } = (await create.json()) as { id: string };
    return { cookie, accountId, invoiceId: id };
  }

  // Revenue is earned when the invoice is ISSUED. invoiceBody dates every
  // fixture 2026-05-23, so a posting stamped "today" is immediately visible.
  it('posts the receivable on the invoice date, not the day it was sent', async () => {
    const ctx = buildApp();
    try {
      const { cookie, accountId, invoiceId } = await seedDraftInvoice(ctx, 'issued@example.com');
      const res = await ctx.app.request(`/api/invoices/${invoiceId}/mark-sent`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(res.status).toBe(200);

      const [entry] = await getTestDb()
        .select()
        .from(journalEntries)
        .where(eq(journalEntries.sourceEntityId, invoiceId));
      expect(entry?.postedAt.toISOString().slice(0, 10)).toBe('2026-05-23');

      // ...while sent_at is still a record of when it actually went out. The
      // two dates answer different questions and must not be conflated.
      const sent = (await (
        await ctx.app.request(`/api/invoices/${invoiceId}`, {
          headers: { cookie, 'x-account-id': accountId },
        })
      ).json()) as { sentAt: string };
      expect(sent.sentAt.slice(0, 10)).not.toBe('2026-05-23');
    } finally {
      await ctx.handle.close();
    }
  });

  // Both sides used to post at `now`, so they netted within a period by
  // accident. Once the revenue moved to the issue date the reversal had to
  // follow, or voiding would leave income in one month and its cancellation in
  // another.
  it('voids a sent invoice back onto the same date it was posted', async () => {
    const ctx = buildApp();
    try {
      const { cookie, accountId, invoiceId } = await seedDraftInvoice(ctx, 'voided@example.com');
      const headers = { cookie, 'x-account-id': accountId };
      await ctx.app.request(`/api/invoices/${invoiceId}/mark-sent`, { method: 'POST', headers });
      await ctx.app.request(`/api/invoices/${invoiceId}/void`, { method: 'POST', headers });

      const entries = await getTestDb()
        .select()
        .from(journalEntries)
        .where(eq(journalEntries.sourceEntityId, invoiceId));
      expect(entries).toHaveLength(2);
      for (const e of entries) {
        expect(e.postedAt.toISOString().slice(0, 10)).toBe('2026-05-23');
      }
    } finally {
      await ctx.handle.close();
    }
  });

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

// TMC-215. mark-paid accepts a DRAFT, so two unconfirmed clicks — mark paid on
// the wrong invoice, then remove the payment — used to leave a document in
// 'sent' with a null sent_at: an invoice the customer has never seen that the
// system believed was issued. It could no longer be edited (PATCH is
// draft-only), it counted as money owed in A/R while the ledger had posted no
// receivable, and voiding it would have reversed revenue that was never posted.
//
// A never-issued invoice settled in cash is a counter sale (TMC-196) — the
// receipt credits revenue, not a receivable. Unwinding it has to return the
// document to the only state consistent with that: draft.
describe('unwinding a receipt on an invoice that was never issued (TMC-215)', () => {
  beforeEach(resetDb);

  async function seedDraftInvoice(
    ctx: CtxApp,
    email: string,
  ): Promise<{
    cookie: string;
    accountId: string;
    companyId: string;
    contactId: string;
    invoiceId: string;
    headers: Record<string, string>;
  }> {
    const cookie = await signUp(ctx.app, email);
    const { accountId, companyId } = await userContext(email);
    const contactId = await createContact(ctx, cookie, accountId, companyId);
    const headers = { cookie, 'x-account-id': accountId, 'content-type': 'application/json' };
    const create = await ctx.app.request('/api/invoices', {
      method: 'POST',
      headers,
      body: JSON.stringify(invoiceBody(companyId, contactId)),
    });
    if (create.status !== 201) throw new Error(`seed invoice failed: ${create.status}`);
    const { id } = (await create.json()) as { id: string };
    return { cookie, accountId, companyId, contactId, invoiceId: id, headers };
  }

  // Signed balance on one chart-of-accounts code, debits − credits, in cents —
  // the same read invoice-payments.integration.test.ts uses. A/R is 1200.
  async function balanceCents(companyId: string, code: string): Promise<number> {
    const [row] = await getTestDb()
      .select({
        net: sql<string>`coalesce(sum(case when ${journalLines.side} = 'debit' then ${journalLines.amount} else -${journalLines.amount} end), 0)::numeric(15,2)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
      .innerJoin(chartOfAccounts, eq(journalLines.coaAccountId, chartOfAccounts.id))
      .where(and(eq(journalEntries.companyId, companyId), eq(chartOfAccounts.code, code)));
    return Math.round(Number(row?.net ?? '0') * 100);
  }

  // mark-paid records a receipt row rather than just stamping the header
  // (TMC-187), and removing that row is how the mistake gets undone. The id
  // only exists on the payments read.
  async function theOnlyPaymentId(
    ctx: CtxApp,
    headers: Record<string, string>,
    invoiceId: string,
  ): Promise<string> {
    const res = await ctx.app.request(`/api/invoices/${invoiceId}/payments`, { headers });
    if (res.status !== 200) throw new Error(`payments read failed: ${res.status}`);
    const body = (await res.json()) as { payments: { id: string }[] };
    const id = body.payments[0]?.id;
    if (!id || body.payments.length !== 1) {
      throw new Error(`expected exactly one payment, got ${body.payments.length}`);
    }
    return id;
  }

  type SettlementResponse = {
    invoice: { status: string; sentAt: string | null; paidAt: string | null };
    settlement: string;
    paid: string;
    outstanding: string;
  };

  it('returns the invoice to draft, still unsent, and editable again', async () => {
    const ctx = buildApp();
    try {
      const { contactId, invoiceId, headers } = await seedDraftInvoice(
        ctx,
        'unissued-undo@example.com',
      );

      const paid = await ctx.app.request(`/api/invoices/${invoiceId}/mark-paid`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ method: 'cash', paidOn: '2026-05-25' }),
      });
      expect(paid.status).toBe(200);
      const paidBody = (await paid.json()) as { status: string; sentAt: string | null };
      expect(paidBody.status).toBe('paid');
      // It was never issued, and marking it paid does not pretend otherwise.
      expect(paidBody.sentAt).toBeNull();

      const paymentId = await theOnlyPaymentId(ctx, headers, invoiceId);
      const removed = await ctx.app.request(`/api/invoices/${invoiceId}/payments/${paymentId}`, {
        method: 'DELETE',
        headers,
      });
      expect(removed.status).toBe(200);
      const removedBody = (await removed.json()) as SettlementResponse;
      expect(removedBody.invoice.status).toBe('draft');
      expect(removedBody.invoice.sentAt).toBeNull();
      expect(removedBody.invoice.paidAt).toBeNull();
      expect(removedBody.settlement).toBe('unpaid');
      expect(removedBody.paid).toBe('0.00');
      expect(removedBody.outstanding).toBe('108.25');

      const db = getTestDb();
      const [row] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
      expect(row?.status).toBe('draft');
      expect(row?.sentAt).toBeNull();
      expect(row?.paidAt).toBeNull();
      expect(row?.paymentMethod).toBeNull();
      // Never issued, so no public link was ever minted — the customer really
      // has not seen this document.
      expect(row?.publicToken).toBeNull();

      // The consequence the user actually feels, and the reason the status
      // string matters: they can fix the invoice they never meant to touch.
      const patch = await ctx.app.request(`/api/invoices/${invoiceId}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          contactId,
          number: 'INV-001',
          issueDate: '2026-05-23',
          dueDate: '2026-06-22',
          subtotal: '250.00',
          tax: '0.00',
          total: '250.00',
          lineItems: [
            {
              position: 1,
              description: 'Rescoped — this was the wrong invoice',
              quantity: '1',
              unitPrice: '250.00',
              amount: '250.00',
            },
          ],
        }),
      });
      expect(patch.status).toBe(200);
      const patched = (await patch.json()) as {
        total: string;
        lineItems: { description: string }[];
      };
      expect(patched.total).toBe('250.00');
      expect(patched.lineItems).toHaveLength(1);
      const [afterPatch] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
      expect(afterPatch?.total).toBe('250.00');
    } finally {
      await ctx.handle.close();
    }
  });

  it('leaves accounts receivable exactly where it found it', async () => {
    const ctx = buildApp();
    try {
      const { cookie, accountId, companyId, contactId, invoiceId, headers } =
        await seedDraftInvoice(ctx, 'unissued-ar@example.com');

      // Give A/R a real balance to be wrong about first: an ordinary issued
      // invoice for the same customer. "Nothing changed" against a zero balance
      // would pass even if the round trip posted and unposted a receivable.
      const other = await ctx.app.request('/api/invoices', {
        method: 'POST',
        headers,
        body: JSON.stringify(invoiceBody(companyId, contactId, 'INV-AR')),
      });
      expect(other.status).toBe(201);
      const { id: issuedId } = (await other.json()) as { id: string };
      const sent = await ctx.app.request(`/api/invoices/${issuedId}/mark-sent`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(sent.status).toBe(200);

      const before = await balanceCents(companyId, '1200');
      expect(before).toBe(10_825);

      const paid = await ctx.app.request(`/api/invoices/${invoiceId}/mark-paid`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ method: 'cash', paidOn: '2026-05-25' }),
      });
      expect(paid.status).toBe(200);
      // A counter sale credits revenue, so A/R never moves on the way in
      // either — the receivable the old bug reported was never posted.
      expect(await balanceCents(companyId, '1200')).toBe(before);

      const paymentId = await theOnlyPaymentId(ctx, headers, invoiceId);
      const removed = await ctx.app.request(`/api/invoices/${invoiceId}/payments/${paymentId}`, {
        method: 'DELETE',
        headers,
      });
      expect(removed.status).toBe(200);
      expect(((await removed.json()) as SettlementResponse).invoice.status).toBe('draft');

      // The assertion the ticket asks for: A/R is byte-for-byte what it was
      // before the whole round trip, and the only receivable on the books is
      // the invoice that was genuinely issued.
      expect(await balanceCents(companyId, '1200')).toBe(before);

      // And the A/R the USER sees agrees with the ledger. This is where the
      // bug actually showed up: the owed buckets are derived from status, not
      // from account 1200, so a draft stranded in 'sent' was chased for money
      // against a receivable that had never been posted. Summing awaiting +
      // overdue rather than naming one keeps this independent of today's date.
      const summary = await ctx.app.request(`/api/invoices/summary?companyId=${companyId}`, {
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(summary.status).toBe(200);
      const buckets = (await summary.json()) as {
        draft: { count: number };
        awaiting: { count: number };
        overdue: { count: number };
      };
      expect(buckets.draft.count).toBe(1);
      expect(buckets.awaiting.count + buckets.overdue.count).toBe(1);
    } finally {
      await ctx.handle.close();
    }
  });

  // The control. Without this the fix could have sent every reopened invoice
  // to draft and the regression test above would still be green.
  it('an ISSUED invoice comes back to sent, not to draft', async () => {
    const ctx = buildApp();
    try {
      const { cookie, accountId, companyId, contactId, invoiceId, headers } =
        await seedDraftInvoice(ctx, 'issued-undo@example.com');
      const sent = await ctx.app.request(`/api/invoices/${invoiceId}/mark-sent`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(sent.status).toBe(200);

      const paid = await ctx.app.request(`/api/invoices/${invoiceId}/mark-paid`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ method: 'cash', paidOn: '2026-05-25' }),
      });
      expect(paid.status).toBe(200);

      const paymentId = await theOnlyPaymentId(ctx, headers, invoiceId);
      const removed = await ctx.app.request(`/api/invoices/${invoiceId}/payments/${paymentId}`, {
        method: 'DELETE',
        headers,
      });
      expect(removed.status).toBe(200);
      const removedBody = (await removed.json()) as SettlementResponse;
      expect(removedBody.invoice.status).toBe('sent');
      expect(removedBody.invoice.sentAt).not.toBeNull();
      expect(removedBody.invoice.paidAt).toBeNull();
      expect(removedBody.settlement).toBe('unpaid');
      expect(removedBody.outstanding).toBe('108.25');

      const db = getTestDb();
      const [row] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
      expect(row?.status).toBe('sent');
      expect(row?.sentAt).not.toBeNull();
      // The customer was billed and has not paid: the receivable is back, at
      // the full amount of the document.
      expect(await balanceCents(companyId, '1200')).toBe(10_825);

      // And it is still NOT editable — the counterparty holds this document.
      // The mirror image of the draft case above.
      const patch = await ctx.app.request(`/api/invoices/${invoiceId}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          contactId,
          number: 'INV-001',
          issueDate: '2026-05-23',
          dueDate: '2026-06-22',
          subtotal: '250.00',
          tax: '0.00',
          total: '250.00',
          lineItems: [
            {
              position: 1,
              description: 'Not allowed',
              quantity: '1',
              unitPrice: '250.00',
              amount: '250.00',
            },
          ],
        }),
      });
      expect(patch.status).toBe(409);
      expect((await patch.json()) as { error: string; status: string }).toMatchObject({
        error: 'not_editable',
        status: 'sent',
      });
    } finally {
      await ctx.handle.close();
    }
  });

  // Deliberate, and pinned so a later refactor has to think about it: there is
  // no "part-paid draft" status to hold this, and money IS on the document, so
  // it maps to 'sent' even though sent_at is still null. The bug was the ZERO
  // case, where nothing justified 'sent' at all.
  it('a part-paid never-issued invoice stays out of draft while money is on it', async () => {
    const ctx = buildApp();
    try {
      const { companyId, invoiceId, headers } = await seedDraftInvoice(
        ctx,
        'unissued-partial@example.com',
      );

      // A draft cannot be part-paid directly — POST /payments refuses one,
      // there being no receivable to pay down. The reachable route is the one a
      // user takes: settle it in cash, then hand part of it back.
      const paid = await ctx.app.request(`/api/invoices/${invoiceId}/mark-paid`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ method: 'cash', paidOn: '2026-05-25' }),
      });
      expect(paid.status).toBe(200);

      const refund = await ctx.app.request(`/api/invoices/${invoiceId}/payments`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ amount: '-58.25', receivedOn: '2026-05-26', method: 'cash' }),
      });
      expect(refund.status).toBe(201);
      const refundBody = (await refund.json()) as SettlementResponse;
      expect(refundBody.settlement).toBe('partial');
      expect(refundBody.paid).toBe('50.00');
      expect(refundBody.outstanding).toBe('58.25');
      expect(refundBody.invoice.status).toBe('sent');
      // 'sent' here is a settlement label, not a claim that it went out.
      expect(refundBody.invoice.sentAt).toBeNull();

      const db = getTestDb();
      const [row] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
      expect(row?.status).toBe('sent');
      expect(row?.sentAt).toBeNull();
      expect(row?.publicToken).toBeNull();
      // And the books still say what they always said: a counter sale, part
      // refunded, with no receivable anywhere.
      expect(await balanceCents(companyId, '1200')).toBe(0);
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
    const contactId = await createContact(ctx, cookie, accountId, companyId);
    const create = await ctx.app.request('/api/invoices', {
      method: 'POST',
      headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
      body: JSON.stringify(invoiceBody(companyId, contactId)),
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

  // TMC-210. The recipient's page renders what this payload says is owed. It
  // carried only `total` while the Pay button charged total − paid, so a
  // customer who had put a deposit down was shown one number and billed
  // another. These pin the settlement fields that close that gap.
  it('the public payload reports an untouched invoice as unpaid, owing the full total', async () => {
    const ctx = buildApp();
    try {
      const { cookie, accountId, invoiceId } = await seedDraftInvoice(
        ctx,
        'pub-unpaid@example.com',
      );
      await ctx.app.request(`/api/invoices/${invoiceId}/mark-sent`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      const db = getTestDb();
      const [row] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));

      const res = await ctx.app.request(`/api/public/invoices/${row?.publicToken}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        total: string;
        paid: string;
        outstanding: string;
        settlement: string;
      };
      expect(body.total).toBe('108.25');
      expect(body.paid).toBe('0.00');
      // Nothing received, so the whole total is still owed — the one case where
      // the old total-only payload happened to be right.
      expect(body.outstanding).toBe('108.25');
      expect(body.settlement).toBe('unpaid');
    } finally {
      await ctx.handle.close();
    }
  });

  it('the public payload reports a deposit as partial and owes only the remainder', async () => {
    const ctx = buildApp();
    try {
      const { cookie, accountId, invoiceId } = await seedDraftInvoice(
        ctx,
        'pub-partial@example.com',
      );
      await ctx.app.request(`/api/invoices/${invoiceId}/mark-sent`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });

      // A real receipt through the app's own endpoint, not a direct row insert —
      // the public view has to agree with the books, so the books have to be the
      // thing that moved.
      const paid = await ctx.app.request(`/api/invoices/${invoiceId}/payments`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({ amount: '50.00', receivedOn: '2026-06-01', method: 'check' }),
      });
      expect(paid.status).toBe(201);

      const db = getTestDb();
      const [row] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));

      const res = await ctx.app.request(`/api/public/invoices/${row?.publicToken}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        total: string;
        paid: string;
        outstanding: string;
        settlement: string;
      };
      // The total is the document's figure and never moves — the deposit shows
      // up beside it, not inside it.
      expect(body.total).toBe('108.25');
      expect(body.paid).toBe('50.00');
      expect(body.outstanding).toBe('58.25');
      expect(body.settlement).toBe('partial');
      // Still open: a deposit does not settle the invoice, and the page must
      // keep offering the Pay button for the rest.
      expect(body.status).toBe('sent');
    } finally {
      await ctx.handle.close();
    }
  });

  it('from-block contact fields are gated per-invoice by the show flags', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'from-flags@example.com');
      const { accountId, companyId } = await userContext('from-flags@example.com');
      const contactId = await createContact(ctx, cookie, accountId, companyId);

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
          ...invoiceBody(companyId, contactId),
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
      const contactId = await createContact(ctx, cookie, accountId, companyId);

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
        body: JSON.stringify(invoiceBody(companyId, contactId)),
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
  ): Promise<{ cookie: string; accountId: string; invoiceId: string; contactId: string }> {
    const cookie = await signUp(ctx.app, signupEmail);
    const { accountId, companyId } = await userContext(signupEmail);
    const contactId = await createContact(
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
      body: JSON.stringify(invoiceBody(companyId, contactId)),
    });
    if (create.status !== 201) throw new Error(`seed invoice failed: ${create.status}`);
    const { id } = (await create.json()) as { id: string };
    return { cookie, accountId, invoiceId: id, contactId };
  }

  // The bug this suite missed for two months: /send flipped draft → sent with
  // its own inline UPDATE instead of going through the transition helper, so an
  // emailed invoice never reached the ledger at all. Every existing test here
  // checked the email and the status; none looked at the books.
  it('puts an emailed invoice on the books, exactly as mark-sent does', async () => {
    const rec = makeRecorder();
    const ctx = buildApp({ mailer: rec.mailer });
    try {
      const { cookie, accountId, invoiceId } = await seedDraftInvoiceWithEmail(
        ctx,
        'emailed-ledger@example.com',
      );
      const res = await ctx.app.request(`/api/invoices/${invoiceId}/send`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);

      const entries = await getTestDb()
        .select()
        .from(journalEntries)
        .where(eq(journalEntries.sourceEntityId, invoiceId));
      expect(entries).toHaveLength(1);
      expect(entries[0]?.postedAt.toISOString().slice(0, 10)).toBe('2026-05-23');

      const lines = await getTestDb()
        .select({
          code: chartOfAccounts.code,
          side: journalLines.side,
          amount: journalLines.amount,
        })
        .from(journalLines)
        .innerJoin(chartOfAccounts, eq(chartOfAccounts.id, journalLines.coaAccountId))
        .where(eq(journalLines.journalEntryId, entries[0]?.id as string));
      const ar = lines.find((l) => l.code === '1200');
      expect(ar).toMatchObject({ side: 'debit', amount: '108.25' });
    } finally {
      await ctx.handle.close();
    }
  });

  // A resend must not post twice. The status guard already prevents it, but the
  // consequence of getting it wrong is doubled revenue rather than a stray row.
  it('does not post again when the same invoice is emailed twice', async () => {
    const rec = makeRecorder();
    const ctx = buildApp({ mailer: rec.mailer });
    try {
      const { cookie, accountId, invoiceId } = await seedDraftInvoiceWithEmail(
        ctx,
        'resend-ledger@example.com',
      );
      const headers = { cookie, 'x-account-id': accountId, 'content-type': 'application/json' };
      await ctx.app.request(`/api/invoices/${invoiceId}/send`, {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      });
      await ctx.app.request(`/api/invoices/${invoiceId}/send`, {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      });

      const entries = await getTestDb()
        .select()
        .from(journalEntries)
        .where(eq(journalEntries.sourceEntityId, invoiceId));
      expect(entries).toHaveLength(1);
    } finally {
      await ctx.handle.close();
    }
  });

  // The flip commits before Resend is called so a mail outage can't roll back a
  // send that already went out. That ordering means the posting has to commit
  // with it — a 502 must still leave the books right, not a sent invoice with
  // no receivable.
  it('keeps the invoice on the books when the mailer fails after the flip', async () => {
    const rec = makeRecorder({ throws: true });
    const ctx = buildApp({ mailer: rec.mailer });
    try {
      const { cookie, accountId, invoiceId } = await seedDraftInvoiceWithEmail(
        ctx,
        'mailfail-ledger@example.com',
      );
      const res = await ctx.app.request(`/api/invoices/${invoiceId}/send`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(502);

      const entries = await getTestDb()
        .select()
        .from(journalEntries)
        .where(eq(journalEntries.sourceEntityId, invoiceId));
      expect(entries).toHaveLength(1);
    } finally {
      await ctx.handle.close();
    }
  });

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
      // company).
      expect(mail?.from).toMatch(/<test@thalermark\.test>$/);
      // This company set neither a reply-to nor a business email, so the chain
      // lands on its terminal no-reply (TMC-225). It used to send NO Reply-To at
      // all, which meant a customer hitting Reply wrote to the platform address
      // in From — mail the business never saw and never knew about.
      //
      // The domain is derived from the configured From, not hardcoded: this
      // fixture sends as thalermark.TEST, and a self-hoster on their own domain
      // must not have replies aimed at one they don't own.
      expect(mail?.replyTo).toBe('no-reply@thalermark.test');

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

describe('GET /api/invoices/summary + derived overdue/awaiting filters', () => {
  beforeEach(resetDb);

  async function makeInvoice(
    ctx: CtxApp,
    cookie: string,
    accountId: string,
    companyId: string,
    contactId: string,
    opts: { number: string; issueDate: string; dueDate: string; total: string; send: boolean },
  ): Promise<string> {
    const res = await ctx.app.request('/api/invoices', {
      method: 'POST',
      headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
      body: JSON.stringify({
        companyId,
        contactId,
        number: opts.number,
        issueDate: opts.issueDate,
        dueDate: opts.dueDate,
        subtotal: opts.total,
        tax: '0.00',
        total: opts.total,
        lineItems: [
          {
            position: 1,
            description: 'Service',
            quantity: '1',
            unitPrice: opts.total,
            amount: opts.total,
          },
        ],
      }),
    });
    if (res.status !== 201) throw new Error(`create failed: ${res.status} ${await res.text()}`);
    const { id } = (await res.json()) as { id: string };
    if (opts.send) {
      const s = await ctx.app.request(`/api/invoices/${id}/mark-sent`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      if (s.status !== 200) throw new Error(`mark-sent failed: ${s.status}`);
    }
    return id;
  }

  it('buckets draft / awaiting / overdue with outstanding $, and the tile filters match', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'summary@example.com');
      const { accountId, companyId } = await userContext('summary@example.com');
      const contactId = await createContact(ctx, cookie, accountId, companyId);

      // Far-future / far-past due dates keep the buckets stable regardless of
      // when the suite runs. A draft's due date is irrelevant (status wins).
      await makeInvoice(ctx, cookie, accountId, companyId, contactId, {
        number: 'INV-D',
        issueDate: '2026-05-01',
        dueDate: '2999-12-31',
        total: '50.00',
        send: false,
      });
      const awaitingId = await makeInvoice(ctx, cookie, accountId, companyId, contactId, {
        number: 'INV-A',
        issueDate: '2026-05-01',
        dueDate: '2999-12-31',
        total: '100.00',
        send: true,
      });
      const overdue1 = await makeInvoice(ctx, cookie, accountId, companyId, contactId, {
        number: 'INV-O1',
        issueDate: '2019-12-01',
        dueDate: '2020-01-01',
        total: '200.00',
        send: true,
      });
      const overdue2 = await makeInvoice(ctx, cookie, accountId, companyId, contactId, {
        number: 'INV-O2',
        issueDate: '2019-12-01',
        dueDate: '2020-01-01',
        total: '25.50',
        send: true,
      });

      const res = await ctx.app.request(`/api/invoices/summary?companyId=${companyId}`, {
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(res.status).toBe(200);
      const s = (await res.json()) as {
        draft: { count: number };
        awaiting: { count: number; total: string };
        overdue: { count: number; total: string };
      };
      expect(s.draft.count).toBe(1);
      expect(s.awaiting.count).toBe(1);
      expect(Number(s.awaiting.total)).toBeCloseTo(100);
      expect(s.overdue.count).toBe(2);
      expect(Number(s.overdue.total)).toBeCloseTo(225.5);

      // Tile click-through: ?overdue=true / ?awaiting=true return exactly their
      // bucket, so the filtered list count matches the tile.
      const od = await ctx.app.request(`/api/invoices?companyId=${companyId}&overdue=true`, {
        headers: { cookie, 'x-account-id': accountId },
      });
      const odBody = (await od.json()) as { invoices: { id: string }[] };
      expect(odBody.invoices.map((i) => i.id).sort()).toEqual([overdue1, overdue2].sort());

      const aw = await ctx.app.request(`/api/invoices?companyId=${companyId}&awaiting=true`, {
        headers: { cookie, 'x-account-id': accountId },
      });
      const awBody = (await aw.json()) as { invoices: { id: string }[] };
      expect(awBody.invoices.map((i) => i.id)).toEqual([awaitingId]);
    } finally {
      await ctx.handle.close();
    }
  });
});

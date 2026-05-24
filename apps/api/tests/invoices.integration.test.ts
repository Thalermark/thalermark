import {
  auditEvents,
  authUser,
  companies,
  invoiceLineItems,
  invoices,
  memberships,
} from '@thalermark/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { getTestDb, resetDb } from './test-helper.js';

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

function buildApp() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const handle = createApiDatabase(url);
  const auth = createApiAuth(handle.db, { ...testEnv, databaseUrl: url });
  const app = createApp({
    auth,
    db: handle.db,
    publicAppUrl: testEnv.publicAppUrl,
    logInviteUrl: () => {},
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
): Promise<string> {
  const res = await app.request('/api/customers', {
    method: 'POST',
    headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
    body: JSON.stringify({ companyId, name }),
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
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(direct.status).toBe(200);
      const db = getTestDb();
      const [paidFromDraft] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
      expect(paidFromDraft?.status).toBe('paid');
      expect(paidFromDraft?.paidAt).not.toBeNull();
      expect(paidFromDraft?.sentAt).toBeNull();

      const second = await seedDraftInvoice(ctx, 'paid2@example.com');
      await ctx.app.request(`/api/invoices/${second.invoiceId}/mark-sent`, {
        method: 'POST',
        headers: { cookie: second.cookie, 'x-account-id': second.accountId },
      });
      const markPaid = await ctx.app.request(`/api/invoices/${second.invoiceId}/mark-paid`, {
        method: 'POST',
        headers: { cookie: second.cookie, 'x-account-id': second.accountId },
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
        headers: { cookie, 'x-account-id': accountId },
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

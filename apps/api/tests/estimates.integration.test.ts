import {
  auditEvents,
  authUser,
  companies,
  estimateLineItems,
  estimates,
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
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const handle = createApiDatabase(appDatabaseUrl());
  const auth = createApiAuth(getTestDb(), { ...testEnv, databaseUrl: url });
  const app = createApp({
    auth,
    db: handle.db,
    bootstrapDb: getTestDb(),
    publicAppUrl: testEnv.publicAppUrl,
    emailFrom: 'Thalermark <test@thalermark.test>',
    mailer: opts.mailer,
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
  const body: Record<string, string> = { companyId, name };
  if (email) body.email = email;
  const res = await app.request('/api/customers', {
    method: 'POST',
    headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status !== 201) throw new Error(`customer create failed: ${res.status}`);
  const out = (await res.json()) as { id: string };
  return out.id;
}

function estimateBody(companyId: string, customerId: string, number = 'EST-001') {
  return {
    companyId,
    customerId,
    number,
    issueDate: '2026-05-23',
    expiresOn: '2026-06-22',
    subtotal: '100.00',
    tax: '8.25',
    total: '108.25',
    lineItems: [
      {
        position: 1,
        description: 'Quote — service',
        quantity: '1',
        unitPrice: '100.00',
        amount: '100.00',
      },
    ],
  };
}

describe('POST /api/estimates', () => {
  beforeEach(resetDb);

  it('creates an estimate + line items in one tx and writes audit', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'quoter@example.com');
      const { accountId, companyId } = await userContext('quoter@example.com');
      const customerId = await createCustomer(ctx, cookie, accountId, companyId);

      const res = await ctx.app.request('/api/estimates', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify(estimateBody(companyId, customerId)),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string };

      const db = getTestDb();
      const [row] = await db.select().from(estimates).where(eq(estimates.id, body.id));
      expect(row?.number).toBe('EST-001');
      expect(row?.status).toBe('draft');
      expect(row?.total).toBe('108.25');
      expect(row?.expiresOn).toBe('2026-06-22');

      const lines = await db
        .select()
        .from(estimateLineItems)
        .where(eq(estimateLineItems.estimateId, body.id));
      expect(lines).toHaveLength(1);
      expect(lines[0]?.amount).toBe('100.00');

      const audits = await db.select().from(auditEvents).where(eq(auditEvents.entityId, body.id));
      expect(audits).toHaveLength(1);
      expect(audits[0]?.entityType).toBe('estimate');
      expect(audits[0]?.action).toBe('create');
    } finally {
      await ctx.handle.close();
    }
  });

  it('allows omitting expiresOn (advisory field is optional)', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'noexp@example.com');
      const { accountId, companyId } = await userContext('noexp@example.com');
      const customerId = await createCustomer(ctx, cookie, accountId, companyId);
      const body = estimateBody(companyId, customerId);
      const { expiresOn: _drop, ...rest } = body;

      const res = await ctx.app.request('/api/estimates', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify(rest),
      });
      expect(res.status).toBe(201);
      const { id } = (await res.json()) as { id: string };
      const [row] = await getTestDb().select().from(estimates).where(eq(estimates.id, id));
      expect(row?.expiresOn).toBeNull();
    } finally {
      await ctx.handle.close();
    }
  });

  it('returns 409 on a duplicate (companyId, number)', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'estdup@example.com');
      const { accountId, companyId } = await userContext('estdup@example.com');
      const customerId = await createCustomer(ctx, cookie, accountId, companyId);

      const first = await ctx.app.request('/api/estimates', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify(estimateBody(companyId, customerId, 'EST-DUP')),
      });
      expect(first.status).toBe(201);

      const second = await ctx.app.request('/api/estimates', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify(estimateBody(companyId, customerId, 'EST-DUP')),
      });
      expect(second.status).toBe(409);
      expect((await second.json()) as { error: string }).toEqual({
        error: 'estimate_number_taken',
      });
    } finally {
      await ctx.handle.close();
    }
  });

  it('rejects a customerId from a different account with 404', async () => {
    const ctx = buildApp();
    try {
      const aCookie = await signUp(ctx.app, 'esta@example.com');
      const aCtx = await userContext('esta@example.com');
      const aCustId = await createCustomer(ctx, aCookie, aCtx.accountId, aCtx.companyId);

      const bCookie = await signUp(ctx.app, 'estb@example.com');
      const bCtx = await userContext('estb@example.com');

      const res = await ctx.app.request('/api/estimates', {
        method: 'POST',
        headers: {
          cookie: bCookie,
          'x-account-id': bCtx.accountId,
          'content-type': 'application/json',
        },
        body: JSON.stringify(estimateBody(bCtx.companyId, aCustId)),
      });
      expect(res.status).toBe(404);
    } finally {
      await ctx.handle.close();
    }
  });

  it('rejects customerId that does not match the requested companyId with 400', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'estmis@example.com');
      const { accountId, companyId } = await userContext('estmis@example.com');
      const customerId = await createCustomer(ctx, cookie, accountId, companyId);

      const otherCompanyId = await (async () => {
        const id = (await import('uuid')).v7();
        await getTestDb().insert(companies).values({ id, accountId, name: 'Side Hustle' });
        return id;
      })();

      const res = await ctx.app.request('/api/estimates', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify(estimateBody(otherCompanyId, customerId)),
      });
      expect(res.status).toBe(400);
    } finally {
      await ctx.handle.close();
    }
  });

  it('rejects a malformed body with 400', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'estbad@example.com');
      const { accountId, companyId } = await userContext('estbad@example.com');
      const customerId = await createCustomer(ctx, cookie, accountId, companyId);
      const body = estimateBody(companyId, customerId);
      const res = await ctx.app.request('/api/estimates', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, total: 'gratis' }),
      });
      expect(res.status).toBe(400);
    } finally {
      await ctx.handle.close();
    }
  });
});

describe('GET /api/estimates and /api/estimates/:id', () => {
  beforeEach(resetDb);

  it('list returns headers; single includes line items', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'estreader@example.com');
      const { accountId, companyId } = await userContext('estreader@example.com');
      const customerId = await createCustomer(ctx, cookie, accountId, companyId);

      const create = await ctx.app.request('/api/estimates', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify(estimateBody(companyId, customerId)),
      });
      const { id } = (await create.json()) as { id: string };

      const list = await ctx.app.request('/api/estimates', {
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(list.status).toBe(200);
      const listBody = (await list.json()) as { estimates: { id: string }[] };
      expect(listBody.estimates.map((r) => r.id)).toContain(id);

      const single = await ctx.app.request(`/api/estimates/${id}`, {
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(single.status).toBe(200);
      const singleBody = (await single.json()) as {
        id: string;
        lineItems: { position: number; description: string }[];
      };
      expect(singleBody.id).toBe(id);
      expect(singleBody.lineItems).toHaveLength(1);
      expect(singleBody.lineItems[0]?.description).toBe('Quote — service');
    } finally {
      await ctx.handle.close();
    }
  });

  it('single returns 404 for a cross-tenant id', async () => {
    const ctx = buildApp();
    try {
      const aCookie = await signUp(ctx.app, 'estxa@example.com');
      const aCtx = await userContext('estxa@example.com');
      const aCust = await createCustomer(ctx, aCookie, aCtx.accountId, aCtx.companyId);
      const create = await ctx.app.request('/api/estimates', {
        method: 'POST',
        headers: {
          cookie: aCookie,
          'x-account-id': aCtx.accountId,
          'content-type': 'application/json',
        },
        body: JSON.stringify(estimateBody(aCtx.companyId, aCust)),
      });
      const { id } = (await create.json()) as { id: string };

      const bCookie = await signUp(ctx.app, 'estxb@example.com');
      const bCtx = await userContext('estxb@example.com');
      const res = await ctx.app.request(`/api/estimates/${id}`, {
        headers: { cookie: bCookie, 'x-account-id': bCtx.accountId },
      });
      expect(res.status).toBe(404);
    } finally {
      await ctx.handle.close();
    }
  });
});

describe('GET /api/estimates/next-number', () => {
  beforeEach(resetDb);

  it('returns EST-0001 when the company has no estimates yet', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'estfirst@example.com');
      const { accountId, companyId } = await userContext('estfirst@example.com');
      const res = await ctx.app.request(`/api/estimates/next-number?companyId=${companyId}`, {
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ suggestion: 'EST-0001' });
    } finally {
      await ctx.handle.close();
    }
  });

  it('increments the trailing integer while preserving prefix and width', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'estinc@example.com');
      const { accountId, companyId } = await userContext('estinc@example.com');
      const customer = await createCustomer(ctx, cookie, accountId, companyId);
      for (const number of ['EST-0041', 'EST-0042']) {
        const post = await ctx.app.request('/api/estimates', {
          method: 'POST',
          headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
          body: JSON.stringify(estimateBody(companyId, customer, number)),
        });
        expect(post.status).toBe(201);
      }
      const res = await ctx.app.request(`/api/estimates/next-number?companyId=${companyId}`, {
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(await res.json()).toEqual({ suggestion: 'EST-0043' });
    } finally {
      await ctx.handle.close();
    }
  });

  it('rejects a missing or malformed companyId with 400', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'estnbad@example.com');
      const { accountId } = await userContext('estnbad@example.com');
      const res = await ctx.app.request('/api/estimates/next-number?companyId=not-a-uuid', {
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(res.status).toBe(400);
    } finally {
      await ctx.handle.close();
    }
  });
});

describe('PATCH /api/estimates/:id', () => {
  beforeEach(resetDb);

  async function seedDraftEstimate(
    ctx: CtxApp,
    email: string,
  ): Promise<{
    cookie: string;
    accountId: string;
    companyId: string;
    customerId: string;
    estimateId: string;
  }> {
    const cookie = await signUp(ctx.app, email);
    const { accountId, companyId } = await userContext(email);
    const customerId = await createCustomer(ctx, cookie, accountId, companyId);
    const create = await ctx.app.request('/api/estimates', {
      method: 'POST',
      headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
      body: JSON.stringify(estimateBody(companyId, customerId)),
    });
    if (create.status !== 201) throw new Error(`seed estimate failed: ${create.status}`);
    const { id } = (await create.json()) as { id: string };
    return { cookie, accountId, companyId, customerId, estimateId: id };
  }

  it('replaces header + line items in one tx and writes an update audit', async () => {
    const ctx = buildApp();
    try {
      const { cookie, accountId, customerId, estimateId } = await seedDraftEstimate(
        ctx,
        'estedit@example.com',
      );

      const newBody = {
        customerId,
        number: 'EST-002',
        issueDate: '2026-06-01',
        expiresOn: '2026-07-01',
        subtotal: '220.00',
        tax: '17.00',
        total: '237.00',
        notes: 'Revised quote',
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
      const res = await ctx.app.request(`/api/estimates/${estimateId}`, {
        method: 'PATCH',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify(newBody),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        number: string;
        total: string;
        expiresOn: string;
        lineItems: { description: string }[];
      };
      expect(body.number).toBe('EST-002');
      expect(body.total).toBe('237.00');
      expect(body.expiresOn).toBe('2026-07-01');
      expect(body.lineItems).toHaveLength(2);

      const db = getTestDb();
      const audits = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.entityId, estimateId));
      const updates = audits.filter((a) => a.action === 'update');
      expect(updates).toHaveLength(1);
    } finally {
      await ctx.handle.close();
    }
  });

  it('rejects PATCH on a non-draft estimate with 409 not_editable', async () => {
    const ctx = buildApp();
    try {
      const { cookie, accountId, customerId, estimateId } = await seedDraftEstimate(
        ctx,
        'estsent@example.com',
      );
      const sent = await ctx.app.request(`/api/estimates/${estimateId}/mark-sent`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(sent.status).toBe(200);

      const patch = await ctx.app.request(`/api/estimates/${estimateId}`, {
        method: 'PATCH',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({
          customerId,
          number: 'EST-NEW',
          issueDate: '2026-06-01',
          subtotal: '50.00',
          total: '50.00',
          lineItems: [
            { position: 1, description: 'New', quantity: '1', unitPrice: '50.00', amount: '50.00' },
          ],
        }),
      });
      expect(patch.status).toBe(409);
      expect((await patch.json()) as { error: string }).toMatchObject({ error: 'not_editable' });
    } finally {
      await ctx.handle.close();
    }
  });
});

describe('Estimate transitions', () => {
  beforeEach(resetDb);

  async function seedDraft(ctx: CtxApp, email: string) {
    const cookie = await signUp(ctx.app, email);
    const { accountId, companyId } = await userContext(email);
    const customerId = await createCustomer(ctx, cookie, accountId, companyId);
    const create = await ctx.app.request('/api/estimates', {
      method: 'POST',
      headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
      body: JSON.stringify(estimateBody(companyId, customerId)),
    });
    if (create.status !== 201) throw new Error(`seed failed: ${create.status}`);
    const { id } = (await create.json()) as { id: string };
    return { cookie, accountId, estimateId: id };
  }

  it('mark-sent: draft → sent, stamps sent_at, mints public_token, writes audit', async () => {
    const ctx = buildApp();
    try {
      const { cookie, accountId, estimateId } = await seedDraft(ctx, 'estsendt@example.com');
      const res = await ctx.app.request(`/api/estimates/${estimateId}/mark-sent`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        sentAt: string | null;
        publicToken: string | null;
      };
      expect(body.status).toBe('sent');
      expect(body.sentAt).not.toBeNull();
      expect(body.publicToken).toBeTruthy();
      expect(body.publicToken?.length).toBe(64); // 32 random bytes hex

      const db = getTestDb();
      const audits = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.entityId, estimateId));
      const transition = audits.find((a) => a.action === 'mark-sent');
      expect(transition).toBeDefined();
    } finally {
      await ctx.handle.close();
    }
  });

  it('mark-accepted from draft → accepted (operator captured a verbal close)', async () => {
    const ctx = buildApp();
    try {
      const { cookie, accountId, estimateId } = await seedDraft(ctx, 'estacc@example.com');
      const res = await ctx.app.request(`/api/estimates/${estimateId}/mark-accepted`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; acceptedAt: string | null };
      expect(body.status).toBe('accepted');
      expect(body.acceptedAt).not.toBeNull();
    } finally {
      await ctx.handle.close();
    }
  });

  it('mark-accepted from sent → accepted', async () => {
    const ctx = buildApp();
    try {
      const { cookie, accountId, estimateId } = await seedDraft(ctx, 'estsentacc@example.com');
      await ctx.app.request(`/api/estimates/${estimateId}/mark-sent`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      const res = await ctx.app.request(`/api/estimates/${estimateId}/mark-accepted`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe('accepted');
    } finally {
      await ctx.handle.close();
    }
  });

  it('mark-declined from accepted → 409 invalid_transition', async () => {
    const ctx = buildApp();
    try {
      const { cookie, accountId, estimateId } = await seedDraft(ctx, 'estdec409@example.com');
      await ctx.app.request(`/api/estimates/${estimateId}/mark-accepted`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      const res = await ctx.app.request(`/api/estimates/${estimateId}/mark-declined`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; from: string; to: string };
      expect(body.error).toBe('invalid_transition');
      expect(body.from).toBe('accepted');
      expect(body.to).toBe('declined');
    } finally {
      await ctx.handle.close();
    }
  });

  it('mark-sent on a non-existent estimate returns 404', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'est404@example.com');
      const { accountId } = await userContext('est404@example.com');
      const fakeId = (await import('uuid')).v7();
      const res = await ctx.app.request(`/api/estimates/${fakeId}/mark-sent`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(res.status).toBe(404);
    } finally {
      await ctx.handle.close();
    }
  });
});

describe('POST /api/estimates/:id/convert', () => {
  beforeEach(resetDb);

  async function seedAccepted(ctx: CtxApp, email: string) {
    const cookie = await signUp(ctx.app, email);
    const { accountId, companyId } = await userContext(email);
    const customerId = await createCustomer(ctx, cookie, accountId, companyId);
    const create = await ctx.app.request('/api/estimates', {
      method: 'POST',
      headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
      body: JSON.stringify(estimateBody(companyId, customerId)),
    });
    if (create.status !== 201) throw new Error(`seed estimate failed: ${create.status}`);
    const { id: estimateId } = (await create.json()) as { id: string };
    const acc = await ctx.app.request(`/api/estimates/${estimateId}/mark-accepted`, {
      method: 'POST',
      headers: { cookie, 'x-account-id': accountId },
    });
    if (acc.status !== 200) throw new Error(`mark-accepted failed: ${acc.status}`);
    return { cookie, accountId, companyId, customerId, estimateId };
  }

  it('copies header + line items into a draft invoice and links the estimate', async () => {
    const ctx = buildApp();
    try {
      const { cookie, accountId, companyId, customerId, estimateId } = await seedAccepted(
        ctx,
        'convok@example.com',
      );

      const res = await ctx.app.request(`/api/estimates/${estimateId}/convert`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(res.status).toBe(201);
      const { id: invoiceId } = (await res.json()) as { id: string };

      const db = getTestDb();
      const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
      expect(inv).toBeDefined();
      expect(inv?.companyId).toBe(companyId);
      expect(inv?.customerId).toBe(customerId);
      expect(inv?.status).toBe('draft');
      expect(inv?.subtotal).toBe('100.00');
      expect(inv?.tax).toBe('8.25');
      expect(inv?.total).toBe('108.25');
      expect(inv?.number).toBe('INV-0001');
      // dueDate is issueDate + 30d
      const issued = new Date(`${inv?.issueDate}T00:00:00Z`).getTime();
      const due = new Date(`${inv?.dueDate}T00:00:00Z`).getTime();
      expect(due - issued).toBe(30 * 24 * 60 * 60 * 1000);

      const lines = await db
        .select()
        .from(invoiceLineItems)
        .where(eq(invoiceLineItems.invoiceId, invoiceId));
      expect(lines).toHaveLength(1);
      expect(lines[0]?.description).toBe('Quote — service');
      expect(lines[0]?.amount).toBe('100.00');

      const [est] = await db.select().from(estimates).where(eq(estimates.id, estimateId));
      expect(est?.convertedInvoiceId).toBe(invoiceId);
      expect(est?.status).toBe('accepted'); // convert does not flip status

      const audits = await db.select().from(auditEvents);
      const estAudit = audits.find((a) => a.entityId === estimateId && a.action === 'convert');
      expect(estAudit).toBeDefined();
      const invAudit = audits.find((a) => a.entityId === invoiceId && a.action === 'create');
      expect(invAudit).toBeDefined();
    } finally {
      await ctx.handle.close();
    }
  });

  it('is idempotent — a second call returns the same invoice id without creating another', async () => {
    const ctx = buildApp();
    try {
      const { cookie, accountId, estimateId } = await seedAccepted(ctx, 'convidem@example.com');

      const first = await ctx.app.request(`/api/estimates/${estimateId}/convert`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(first.status).toBe(201);
      const { id: firstId } = (await first.json()) as { id: string };

      const second = await ctx.app.request(`/api/estimates/${estimateId}/convert`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(second.status).toBe(200);
      const { id: secondId } = (await second.json()) as { id: string };
      expect(secondId).toBe(firstId);

      const db = getTestDb();
      const allInvoices = await db.select().from(invoices);
      expect(allInvoices).toHaveLength(1);
    } finally {
      await ctx.handle.close();
    }
  });

  it('rejects convert on draft / sent / declined with 409 invalid_transition', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'convgate@example.com');
      const { accountId, companyId } = await userContext('convgate@example.com');
      const customerId = await createCustomer(ctx, cookie, accountId, companyId);

      async function makeEstimate(number: string): Promise<string> {
        const r = await ctx.app.request('/api/estimates', {
          method: 'POST',
          headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
          body: JSON.stringify(estimateBody(companyId, customerId, number)),
        });
        if (r.status !== 201) throw new Error(`seed ${number} failed: ${r.status}`);
        return ((await r.json()) as { id: string }).id;
      }

      const draftId = await makeEstimate('EST-DRAFT');
      const sentId = await makeEstimate('EST-SENT');
      const declinedId = await makeEstimate('EST-DECL');
      await ctx.app.request(`/api/estimates/${sentId}/mark-sent`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      await ctx.app.request(`/api/estimates/${declinedId}/mark-declined`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });

      for (const id of [draftId, sentId, declinedId]) {
        const res = await ctx.app.request(`/api/estimates/${id}/convert`, {
          method: 'POST',
          headers: { cookie, 'x-account-id': accountId },
        });
        expect(res.status).toBe(409);
        const body = (await res.json()) as { error: string };
        expect(body.error).toBe('invalid_transition');
      }
    } finally {
      await ctx.handle.close();
    }
  });

  it('returns 404 for a non-existent estimate id', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'conv404@example.com');
      const { accountId } = await userContext('conv404@example.com');
      const fakeId = (await import('uuid')).v7();
      const res = await ctx.app.request(`/api/estimates/${fakeId}/convert`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(res.status).toBe(404);
    } finally {
      await ctx.handle.close();
    }
  });

  it('returns 404 when the estimate belongs to another account', async () => {
    const ctx = buildApp();
    try {
      const {
        cookie: aCookie,
        accountId: aAccountId,
        estimateId,
      } = await seedAccepted(ctx, 'convxa@example.com');
      // Sanity — a's own convert works
      const own = await ctx.app.request(`/api/estimates/${estimateId}/convert`, {
        method: 'POST',
        headers: { cookie: aCookie, 'x-account-id': aAccountId },
      });
      expect(own.status).toBe(201);

      const bCookie = await signUp(ctx.app, 'convxb@example.com');
      const bCtx = await userContext('convxb@example.com');
      const cross = await ctx.app.request(`/api/estimates/${estimateId}/convert`, {
        method: 'POST',
        headers: { cookie: bCookie, 'x-account-id': bCtx.accountId },
      });
      expect(cross.status).toBe(404);
    } finally {
      await ctx.handle.close();
    }
  });
});

describe('POST /api/estimates/:id/send', () => {
  beforeEach(resetDb);

  type SentMail = { to: string; subject: string; html: string; text: string };
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

  async function seedDraftWithEmail(
    ctx: CtxApp,
    signupEmail: string,
    customerEmail: string | null = 'recipient@example.test',
  ): Promise<{ cookie: string; accountId: string; estimateId: string }> {
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
    const create = await ctx.app.request('/api/estimates', {
      method: 'POST',
      headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
      body: JSON.stringify(estimateBody(companyId, customerId)),
    });
    if (create.status !== 201) throw new Error(`seed estimate failed: ${create.status}`);
    const { id } = (await create.json()) as { id: string };
    return { cookie, accountId, estimateId: id };
  }

  it('first send transitions draft → sent, emails the customer, writes both audit rows', async () => {
    const rec = makeRecorder();
    const ctx = buildApp({ mailer: rec.mailer });
    try {
      const { cookie, accountId, estimateId } = await seedDraftWithEmail(
        ctx,
        'estsend@example.com',
      );
      const res = await ctx.app.request(`/api/estimates/${estimateId}/send`, {
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
      expect(body.sentTo).toBe('recipient@example.test');

      expect(rec.sent).toHaveLength(1);
      const mail = rec.sent[0];
      expect(mail?.to).toBe('recipient@example.test');
      expect(mail?.subject).toMatch(/Estimate EST-001/);
      expect(mail?.html).toContain(`/e/${body.publicToken}`);
      expect(mail?.text).toContain(`/e/${body.publicToken}`);

      const db = getTestDb();
      const audits = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.entityId, estimateId));
      expect(audits.map((a) => a.action).sort()).toEqual(['create', 'email-sent', 'mark-sent']);
    } finally {
      await ctx.handle.close();
    }
  });

  it('resend on a sent estimate emails again without re-minting the token', async () => {
    const rec = makeRecorder();
    const ctx = buildApp({ mailer: rec.mailer });
    try {
      const { cookie, accountId, estimateId } = await seedDraftWithEmail(
        ctx,
        'estresend@example.com',
      );
      const first = await ctx.app.request(`/api/estimates/${estimateId}/send`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(first.status).toBe(200);
      const db = getTestDb();
      const [afterFirst] = await db.select().from(estimates).where(eq(estimates.id, estimateId));
      const minted = afterFirst?.publicToken;
      const firstSentAt = afterFirst?.sentAt;

      const second = await ctx.app.request(`/api/estimates/${estimateId}/send`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(second.status).toBe(200);
      expect(rec.sent).toHaveLength(2);

      const [afterSecond] = await db.select().from(estimates).where(eq(estimates.id, estimateId));
      expect(afterSecond?.publicToken).toBe(minted);
      expect(afterSecond?.sentAt?.getTime()).toBe(firstSentAt?.getTime());
    } finally {
      await ctx.handle.close();
    }
  });

  it('rejects send on accepted with 409', async () => {
    const rec = makeRecorder();
    const ctx = buildApp({ mailer: rec.mailer });
    try {
      const { cookie, accountId, estimateId } = await seedDraftWithEmail(
        ctx,
        'estsend409@example.com',
      );
      const accept = await ctx.app.request(`/api/estimates/${estimateId}/mark-accepted`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(accept.status).toBe(200);

      const res = await ctx.app.request(`/api/estimates/${estimateId}/send`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; from: string };
      expect(body.error).toBe('invalid_transition');
      expect(body.from).toBe('accepted');
      expect(rec.sent).toHaveLength(0);
    } finally {
      await ctx.handle.close();
    }
  });

  it('mailer failure surfaces 502 BUT the status transition still commits', async () => {
    const rec = makeRecorder({ throws: true });
    const ctx = buildApp({ mailer: rec.mailer });
    try {
      const { cookie, accountId, estimateId } = await seedDraftWithEmail(
        ctx,
        'estmailerfail@example.com',
      );
      const res = await ctx.app.request(`/api/estimates/${estimateId}/send`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(502);

      const db = getTestDb();
      const [row] = await db.select().from(estimates).where(eq(estimates.id, estimateId));
      expect(row?.status).toBe('sent');
      expect(row?.publicToken).toBeTruthy();
    } finally {
      await ctx.handle.close();
    }
  });

  it('returns 500 email_not_configured when no mailer is wired in', async () => {
    const ctx = buildApp();
    try {
      const { cookie, accountId, estimateId } = await seedDraftWithEmail(
        ctx,
        'estnomailer@example.com',
      );
      const res = await ctx.app.request(`/api/estimates/${estimateId}/send`, {
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

  it('uses the `to` override when supplied', async () => {
    const rec = makeRecorder();
    const ctx = buildApp({ mailer: rec.mailer });
    try {
      const { cookie, accountId, estimateId } = await seedDraftWithEmail(
        ctx,
        'estoverride@example.com',
      );
      const res = await ctx.app.request(`/api/estimates/${estimateId}/send`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({ to: 'somebody.else@example.test' }),
      });
      expect(res.status).toBe(200);
      expect(rec.sent[0]?.to).toBe('somebody.else@example.test');
    } finally {
      await ctx.handle.close();
    }
  });
});

describe('Public estimate routes', () => {
  beforeEach(resetDb);

  // Builds a fresh ctx wired with a recorder mailer + seeds a sent estimate
  // (draft → sent via /send, which mints the public_token). Returns the
  // token and ids for assertion. The seed helper closes/swaps the caller's
  // ctx in place so each test still owns a single connection lifecycle.
  async function seedSent(
    ctx: CtxApp,
    email: string,
  ): Promise<{ token: string; estimateId: string; accountId: string }> {
    const rec = {
      sent: [] as { to: string; subject: string; html: string; text: string }[],
      mailer: {
        async send(msg: { to: string; subject: string; html: string; text: string }) {
          rec.sent.push(msg);
        },
      },
    };
    await ctx.handle.close();
    const next = buildApp({ mailer: rec.mailer });
    ctx.app = next.app;
    ctx.handle = next.handle;

    const cookie = await signUp(ctx.app, email);
    const { accountId, companyId } = await userContext(email);
    const customerId = await createCustomer(
      ctx,
      cookie,
      accountId,
      companyId,
      'Wile E. Coyote',
      'recipient@example.test',
    );
    const create = await ctx.app.request('/api/estimates', {
      method: 'POST',
      headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
      body: JSON.stringify(estimateBody(companyId, customerId)),
    });
    if (create.status !== 201) throw new Error(`seed estimate failed: ${create.status}`);
    const { id: estimateId } = (await create.json()) as { id: string };
    const send = await ctx.app.request(`/api/estimates/${estimateId}/send`, {
      method: 'POST',
      headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
      body: '{}',
    });
    if (send.status !== 200) throw new Error(`seed send failed: ${send.status}`);
    const [row] = await getTestDb().select().from(estimates).where(eq(estimates.id, estimateId));
    if (!row?.publicToken) throw new Error('seed: no public_token minted');
    return { token: row.publicToken, estimateId, accountId };
  }

  it('GET /api/public/estimates/:token returns the rendered estimate without a session', async () => {
    const ctx = buildApp();
    try {
      const { token } = await seedSent(ctx, 'pubview@example.com');
      const res = await ctx.app.request(`/api/public/estimates/${token}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        number: string;
        status: string;
        total: string;
        customerName: string | null;
        companyName: string | null;
        lineItems: { description: string }[];
        canRespond: boolean;
      };
      expect(body.number).toBe('EST-001');
      expect(body.status).toBe('sent');
      expect(body.total).toBe('108.25');
      expect(body.customerName).toBe('Wile E. Coyote');
      expect(body.lineItems).toHaveLength(1);
      expect(body.canRespond).toBe(true);
      // No account/company ids leak to the recipient
      expect(body as Record<string, unknown>).not.toHaveProperty('accountId');
      expect(body as Record<string, unknown>).not.toHaveProperty('companyId');
    } finally {
      await ctx.handle.close();
    }
  });

  it('GET returns 404 for an unknown token', async () => {
    const ctx = buildApp();
    try {
      const res = await ctx.app.request('/api/public/estimates/not-a-real-token');
      expect(res.status).toBe(404);
    } finally {
      await ctx.handle.close();
    }
  });

  it('POST /accept transitions sent → accepted and writes a public-accept audit', async () => {
    const ctx = buildApp();
    try {
      const { token, estimateId, accountId } = await seedSent(ctx, 'pubacc@example.com');
      const res = await ctx.app.request(`/api/public/estimates/${token}/accept`, {
        method: 'POST',
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; acceptedAt: string | null };
      expect(body.status).toBe('accepted');
      expect(body.acceptedAt).not.toBeNull();

      const db = getTestDb();
      const [row] = await db.select().from(estimates).where(eq(estimates.id, estimateId));
      expect(row?.status).toBe('accepted');

      const audits = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.entityId, estimateId));
      const pub = audits.find((a) => a.action === 'public-accept');
      expect(pub).toBeDefined();
      expect(pub?.accountId).toBe(accountId);
    } finally {
      await ctx.handle.close();
    }
  });

  it('POST /decline transitions sent → declined and writes a public-decline audit', async () => {
    const ctx = buildApp();
    try {
      const { token, estimateId } = await seedSent(ctx, 'pubdec@example.com');
      const res = await ctx.app.request(`/api/public/estimates/${token}/decline`, {
        method: 'POST',
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; declinedAt: string | null };
      expect(body.status).toBe('declined');
      expect(body.declinedAt).not.toBeNull();

      const db = getTestDb();
      const audits = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.entityId, estimateId));
      expect(audits.some((a) => a.action === 'public-decline')).toBe(true);
    } finally {
      await ctx.handle.close();
    }
  });

  it('POST /accept on a non-sent estimate returns 409 invalid_transition', async () => {
    const ctx = buildApp();
    try {
      const { token } = await seedSent(ctx, 'pubacc409@example.com');
      // First accept lands; second hits a non-sent state.
      const first = await ctx.app.request(`/api/public/estimates/${token}/accept`, {
        method: 'POST',
      });
      expect(first.status).toBe(200);
      const second = await ctx.app.request(`/api/public/estimates/${token}/accept`, {
        method: 'POST',
      });
      expect(second.status).toBe(409);
      const body = (await second.json()) as { error: string; from: string };
      expect(body.error).toBe('invalid_transition');
      expect(body.from).toBe('accepted');
    } finally {
      await ctx.handle.close();
    }
  });

  it('POST /accept on an unknown token returns 404', async () => {
    const ctx = buildApp();
    try {
      const res = await ctx.app.request('/api/public/estimates/nope/accept', { method: 'POST' });
      expect(res.status).toBe(404);
    } finally {
      await ctx.handle.close();
    }
  });
});

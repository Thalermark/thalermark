import { authUser, companies, memberships } from '@thalermark/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// Late-payer detection (deterministic). Exercises
// GET /api/contacts/:id/payment-reliability: late vs on-time counts from paid
// invoices, overdue tally, the empty-history shape, and tenant isolation.
// "Late" = paid after the due date; we control lateness with the due date
// (past → late once paid today; far-future → on time).

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

type Auth = { cookie: string; accountId: string };

async function createContact(
  app: ReturnType<typeof createApp>,
  auth: Auth,
  companyId: string,
): Promise<string> {
  const res = await app.request('/api/contacts', {
    method: 'POST',
    headers: {
      cookie: auth.cookie,
      'x-account-id': auth.accountId,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ companyId, name: 'Wile E. Coyote' }),
  });
  if (res.status !== 201) throw new Error(`customer create failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

// Create an invoice then drive it to `to` ('sent' or 'paid'). dueDate controls
// lateness; total feeds the overdue tally.
async function invoice(
  app: ReturnType<typeof createApp>,
  auth: Auth,
  companyId: string,
  contactId: string,
  opts: { number: string; dueDate: string; total: string; to: 'sent' | 'paid' },
) {
  const headers = {
    cookie: auth.cookie,
    'x-account-id': auth.accountId,
    'content-type': 'application/json',
  };
  const res = await app.request('/api/invoices', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      companyId,
      contactId,
      number: opts.number,
      issueDate: '2026-01-01',
      dueDate: opts.dueDate,
      subtotal: opts.total,
      tax: '0',
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
  if (res.status !== 201) throw new Error(`invoice create failed: ${res.status}`);
  const { id } = (await res.json()) as { id: string };
  const sent = await app.request(`/api/invoices/${id}/mark-sent`, { method: 'POST', headers });
  if (sent.status !== 200) throw new Error(`mark-sent failed: ${sent.status}`);
  if (opts.to === 'paid') {
    const paid = await app.request(`/api/invoices/${id}/mark-paid`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'cash' }),
    });
    if (paid.status !== 200) throw new Error(`mark-paid failed: ${paid.status}`);
  }
  return id;
}

function reliability(app: ReturnType<typeof createApp>, auth: Auth, contactId: string) {
  return app.request(`/api/contacts/${contactId}/payment-reliability`, {
    headers: { cookie: auth.cookie, 'x-account-id': auth.accountId },
  });
}

type Reliability = {
  paidCount: number;
  lateCount: number;
  onTimeCount: number;
  latePct: number | null;
  avgDaysLate: number | null;
  overdueCount: number;
  overdueTotal: string;
};

beforeEach(resetDb);

describe('payment reliability', () => {
  it('counts late vs on-time paid invoices and tallies overdue', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'pay@example.com');
      const { accountId, companyId } = await userContext('pay@example.com');
      const auth: Auth = { cookie, accountId };
      const contactId = await createContact(ctx.app, auth, companyId);

      // Two paid late (due in the past), one paid on time (due far in future).
      await invoice(ctx.app, auth, companyId, contactId, {
        number: 'INV-1',
        dueDate: '2026-01-01',
        total: '100.00',
        to: 'paid',
      });
      await invoice(ctx.app, auth, companyId, contactId, {
        number: 'INV-2',
        dueDate: '2026-01-02',
        total: '100.00',
        to: 'paid',
      });
      await invoice(ctx.app, auth, companyId, contactId, {
        number: 'INV-3',
        dueDate: '2099-01-01',
        total: '100.00',
        to: 'paid',
      });
      // One sent + unpaid + past due → overdue now.
      await invoice(ctx.app, auth, companyId, contactId, {
        number: 'INV-4',
        dueDate: '2026-01-03',
        total: '150.00',
        to: 'sent',
      });

      const res = await reliability(ctx.app, auth, contactId);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Reliability;
      expect(body.paidCount).toBe(3);
      expect(body.lateCount).toBe(2);
      expect(body.onTimeCount).toBe(1);
      expect(body.latePct).toBe(67); // 2/3 → 67%
      expect(body.avgDaysLate).not.toBeNull();
      expect(body.avgDaysLate as number).toBeGreaterThan(0); // past-due payments dominate
      expect(body.overdueCount).toBe(1);
      expect(body.overdueTotal).toBe('150.00');
    } finally {
      await ctx.handle.close();
    }
  });

  it('returns an empty shape for a customer with no invoices', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'pay-empty@example.com');
      const { accountId, companyId } = await userContext('pay-empty@example.com');
      const auth: Auth = { cookie, accountId };
      const contactId = await createContact(ctx.app, auth, companyId);

      const body = (await (await reliability(ctx.app, auth, contactId)).json()) as Reliability;
      expect(body).toMatchObject({
        paidCount: 0,
        lateCount: 0,
        onTimeCount: 0,
        latePct: null,
        avgDaysLate: null,
        overdueCount: 0,
        overdueTotal: '0.00',
      });
    } finally {
      await ctx.handle.close();
    }
  });

  it("404s for another account's customer", async () => {
    const ctx = buildApp();
    try {
      const cookieA = await signUp(ctx.app, 'pay-a@example.com');
      const a = await userContext('pay-a@example.com');
      const customerA = await createContact(
        ctx.app,
        { cookie: cookieA, accountId: a.accountId },
        a.companyId,
      );

      const cookieB = await signUp(ctx.app, 'pay-b@example.com');
      const b = await userContext('pay-b@example.com');

      const res = await reliability(
        ctx.app,
        { cookie: cookieB, accountId: b.accountId },
        customerA,
      );
      expect(res.status).toBe(404);
    } finally {
      await ctx.handle.close();
    }
  });
});

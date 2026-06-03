import { authUser, companies, memberships } from '@thalermark/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { getTestDb, resetDb } from './test-helper.js';

// Duplicate-as-template. Exercises POST /api/invoices/:id/duplicate: clones the
// header + line items into a fresh draft (new number, today/Net-30, status and
// stamps reset), is repeatable (each call mints a new draft), and is tenant-
// isolated.

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
  const handle = createApiDatabase(url);
  const auth = createApiAuth(handle.db, { ...testEnv, databaseUrl: url });
  const app = createApp({ auth, db: handle.db, publicAppUrl: testEnv.publicAppUrl });
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

function headers(auth: Auth) {
  return {
    cookie: auth.cookie,
    'x-account-id': auth.accountId,
    'content-type': 'application/json',
  };
}

async function createCustomer(app: ReturnType<typeof createApp>, auth: Auth, companyId: string) {
  const res = await app.request('/api/customers', {
    method: 'POST',
    headers: headers(auth),
    body: JSON.stringify({ companyId, name: 'Wile E. Coyote' }),
  });
  if (res.status !== 201) throw new Error(`customer create failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

async function createInvoice(
  app: ReturnType<typeof createApp>,
  auth: Auth,
  companyId: string,
  customerId: string,
) {
  const res = await app.request('/api/invoices', {
    method: 'POST',
    headers: headers(auth),
    body: JSON.stringify({
      companyId,
      customerId,
      number: 'INV-0001',
      issueDate: '2026-01-01',
      dueDate: '2026-02-01',
      subtotal: '100.00',
      tax: '0',
      total: '100.00',
      lineItems: [
        {
          position: 1,
          description: 'Tune-up',
          quantity: '2',
          unitPrice: '50.00',
          amount: '100.00',
        },
      ],
    }),
  });
  if (res.status !== 201) throw new Error(`invoice create failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

type Invoice = {
  id: string;
  number: string;
  status: string;
  customerId: string;
  total: string;
  subtotal: string;
  sentAt: string | null;
  publicToken: string | null;
  lineItems: { description: string; amount: string }[];
};

async function getInvoice(app: ReturnType<typeof createApp>, auth: Auth, id: string) {
  const res = await app.request(`/api/invoices/${id}`, {
    headers: { cookie: auth.cookie, 'x-account-id': auth.accountId },
  });
  if (res.status !== 200) throw new Error(`invoice get failed: ${res.status}`);
  return (await res.json()) as Invoice;
}

function duplicate(app: ReturnType<typeof createApp>, auth: Auth, id: string) {
  return app.request(`/api/invoices/${id}/duplicate`, { method: 'POST', headers: headers(auth) });
}

beforeEach(resetDb);

describe('invoice duplicate-as-template', () => {
  it('clones a sent invoice into a fresh draft, resetting number/status/stamps', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'dup@example.com');
      const { accountId, companyId } = await userContext('dup@example.com');
      const auth: Auth = { cookie, accountId };
      const customerId = await createCustomer(ctx.app, auth, companyId);
      const sourceId = await createInvoice(ctx.app, auth, companyId, customerId);

      // Send it so the source carries a number, status, sent stamp + token —
      // none of which should leak into the duplicate.
      const sent = await ctx.app.request(`/api/invoices/${sourceId}/mark-sent`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(sent.status).toBe(200);

      const res = await duplicate(ctx.app, auth, sourceId);
      expect(res.status).toBe(201);
      const { id: dupId } = (await res.json()) as { id: string };
      expect(dupId).not.toBe(sourceId);

      const dup = await getInvoice(ctx.app, auth, dupId);
      expect(dup.status).toBe('draft');
      expect(dup.number).not.toBe('INV-0001'); // fresh auto-number
      expect(dup.sentAt).toBeNull();
      expect(dup.publicToken).toBeNull();
      // Copied: customer, amounts, line items.
      expect(dup.customerId).toBe(customerId);
      expect(dup.total).toBe('100.00');
      expect(dup.subtotal).toBe('100.00');
      expect(dup.lineItems).toHaveLength(1);
      expect(dup.lineItems[0]?.description).toBe('Tune-up');
      expect(dup.lineItems[0]?.amount).toBe('100.00');
    } finally {
      await ctx.handle.close();
    }
  });

  it('is repeatable — each call mints a new draft with its own number', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'dup-rep@example.com');
      const { accountId, companyId } = await userContext('dup-rep@example.com');
      const auth: Auth = { cookie, accountId };
      const customerId = await createCustomer(ctx.app, auth, companyId);
      const sourceId = await createInvoice(ctx.app, auth, companyId, customerId);

      const first = (await (await duplicate(ctx.app, auth, sourceId)).json()) as { id: string };
      const second = (await (await duplicate(ctx.app, auth, sourceId)).json()) as { id: string };
      expect(second.id).not.toBe(first.id);
      const a = await getInvoice(ctx.app, auth, first.id);
      const b = await getInvoice(ctx.app, auth, second.id);
      expect(b.number).not.toBe(a.number);
    } finally {
      await ctx.handle.close();
    }
  });

  it("404s for another account's invoice", async () => {
    const ctx = buildApp();
    try {
      const cookieA = await signUp(ctx.app, 'dup-a@example.com');
      const a = await userContext('dup-a@example.com');
      const authA: Auth = { cookie: cookieA, accountId: a.accountId };
      const customerA = await createCustomer(ctx.app, authA, a.companyId);
      const sourceId = await createInvoice(ctx.app, authA, a.companyId, customerA);

      const cookieB = await signUp(ctx.app, 'dup-b@example.com');
      const b = await userContext('dup-b@example.com');

      const res = await duplicate(ctx.app, { cookie: cookieB, accountId: b.accountId }, sourceId);
      expect(res.status).toBe(404);
    } finally {
      await ctx.handle.close();
    }
  });
});

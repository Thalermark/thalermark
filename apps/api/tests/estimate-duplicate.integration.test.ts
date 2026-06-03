import { authUser, companies, memberships } from '@thalermark/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { getTestDb, resetDb } from './test-helper.js';

// Duplicate-as-template for estimates (mirrors the invoice case). Clones header
// + line items into a fresh draft (new number, today/+30 expiry, status +
// stamps + public token + converted-link reset), repeatable, tenant-isolated.

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

async function createEstimate(
  app: ReturnType<typeof createApp>,
  auth: Auth,
  companyId: string,
  customerId: string,
) {
  const res = await app.request('/api/estimates', {
    method: 'POST',
    headers: headers(auth),
    body: JSON.stringify({
      companyId,
      customerId,
      number: 'EST-0001',
      issueDate: '2026-01-01',
      expiresOn: '2026-02-01',
      subtotal: '200.00',
      tax: '0',
      total: '200.00',
      lineItems: [
        {
          position: 1,
          description: 'Deck rebuild',
          quantity: '1',
          unitPrice: '200.00',
          amount: '200.00',
        },
      ],
    }),
  });
  if (res.status !== 201) throw new Error(`estimate create failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

type Estimate = {
  id: string;
  number: string;
  status: string;
  customerId: string;
  total: string;
  sentAt: string | null;
  publicToken: string | null;
  convertedInvoiceId: string | null;
  lineItems: { description: string; amount: string }[];
};

async function getEstimate(app: ReturnType<typeof createApp>, auth: Auth, id: string) {
  const res = await app.request(`/api/estimates/${id}`, {
    headers: { cookie: auth.cookie, 'x-account-id': auth.accountId },
  });
  if (res.status !== 200) throw new Error(`estimate get failed: ${res.status}`);
  return (await res.json()) as Estimate;
}

function duplicate(app: ReturnType<typeof createApp>, auth: Auth, id: string) {
  return app.request(`/api/estimates/${id}/duplicate`, { method: 'POST', headers: headers(auth) });
}

beforeEach(resetDb);

describe('estimate duplicate-as-template', () => {
  it('clones a sent estimate into a fresh draft, resetting number/status/stamps', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'edup@example.com');
      const { accountId, companyId } = await userContext('edup@example.com');
      const auth: Auth = { cookie, accountId };
      const customerId = await createCustomer(ctx.app, auth, companyId);
      const sourceId = await createEstimate(ctx.app, auth, companyId, customerId);

      const sent = await ctx.app.request(`/api/estimates/${sourceId}/mark-sent`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(sent.status).toBe(200);

      const res = await duplicate(ctx.app, auth, sourceId);
      expect(res.status).toBe(201);
      const { id: dupId } = (await res.json()) as { id: string };
      expect(dupId).not.toBe(sourceId);

      const dup = await getEstimate(ctx.app, auth, dupId);
      expect(dup.status).toBe('draft');
      expect(dup.number).not.toBe('EST-0001');
      expect(dup.sentAt).toBeNull();
      expect(dup.publicToken).toBeNull();
      expect(dup.convertedInvoiceId).toBeNull();
      expect(dup.customerId).toBe(customerId);
      expect(dup.total).toBe('200.00');
      expect(dup.lineItems).toHaveLength(1);
      expect(dup.lineItems[0]?.description).toBe('Deck rebuild');
    } finally {
      await ctx.handle.close();
    }
  });

  it('is repeatable — each call mints a new draft with its own number', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'edup-rep@example.com');
      const { accountId, companyId } = await userContext('edup-rep@example.com');
      const auth: Auth = { cookie, accountId };
      const customerId = await createCustomer(ctx.app, auth, companyId);
      const sourceId = await createEstimate(ctx.app, auth, companyId, customerId);

      const first = (await (await duplicate(ctx.app, auth, sourceId)).json()) as { id: string };
      const second = (await (await duplicate(ctx.app, auth, sourceId)).json()) as { id: string };
      expect(second.id).not.toBe(first.id);
      const a = await getEstimate(ctx.app, auth, first.id);
      const b = await getEstimate(ctx.app, auth, second.id);
      expect(b.number).not.toBe(a.number);
    } finally {
      await ctx.handle.close();
    }
  });

  it("404s for another account's estimate", async () => {
    const ctx = buildApp();
    try {
      const cookieA = await signUp(ctx.app, 'edup-a@example.com');
      const a = await userContext('edup-a@example.com');
      const authA: Auth = { cookie: cookieA, accountId: a.accountId };
      const customerA = await createCustomer(ctx.app, authA, a.companyId);
      const sourceId = await createEstimate(ctx.app, authA, a.companyId, customerA);

      const cookieB = await signUp(ctx.app, 'edup-b@example.com');
      const b = await userContext('edup-b@example.com');

      const res = await duplicate(ctx.app, { cookie: cookieB, accountId: b.accountId }, sourceId);
      expect(res.status).toBe(404);
    } finally {
      await ctx.handle.close();
    }
  });
});

import { authUser, companies, memberships } from '@thalermark/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// Keyset cursor pagination is implemented once in src/lib/pagination.ts and
// applied uniformly across the list endpoints, so we exercise the contract
// against two representative shapes: customers (newest-first, createdAt+id
// desc) and items (alphabetical, name+id asc). The remaining endpoints reuse
// the same helpers and are covered for behavior in their own suites.

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

type Ctx = { cookie: string; accountId: string; companyId: string };

async function setup(app: ReturnType<typeof createApp>, email: string): Promise<Ctx> {
  const cookie = await signUp(app, email);
  const { accountId, companyId } = await userContext(email);
  return { cookie, accountId, companyId };
}

function createCustomer(app: ReturnType<typeof createApp>, ctx: Ctx, name: string) {
  return app.request('/api/customers', {
    method: 'POST',
    headers: {
      cookie: ctx.cookie,
      'x-account-id': ctx.accountId,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ companyId: ctx.companyId, name }),
  });
}

function getCustomers(app: ReturnType<typeof createApp>, ctx: Ctx, query: string) {
  return app.request(`/api/customers${query}`, {
    headers: { cookie: ctx.cookie, 'x-account-id': ctx.accountId },
  });
}

describe('GET /api/customers — keyset pagination (newest-first)', () => {
  beforeEach(resetDb);

  it('walks pages newest-first, round-trips the cursor, ends with null', async () => {
    const { app, handle } = buildApp();
    try {
      const ctx = await setup(app, 'pager@example.com');
      // Created oldest -> newest; the list returns newest first.
      for (const n of ['C1', 'C2', 'C3', 'C4', 'C5']) {
        const r = await createCustomer(app, ctx, n);
        expect(r.status).toBe(201);
      }

      const page1 = (await (await getCustomers(app, ctx, '?limit=2')).json()) as {
        customers: { name: string }[];
        nextCursor: string | null;
      };
      expect(page1.customers.map((c) => c.name)).toEqual(['C5', 'C4']);
      expect(page1.nextCursor).toBeTruthy();

      const page2 = (await (
        await getCustomers(
          app,
          ctx,
          `?limit=2&cursor=${encodeURIComponent(page1.nextCursor ?? '')}`,
        )
      ).json()) as { customers: { name: string }[]; nextCursor: string | null };
      expect(page2.customers.map((c) => c.name)).toEqual(['C3', 'C2']);
      expect(page2.nextCursor).toBeTruthy();

      const page3 = (await (
        await getCustomers(
          app,
          ctx,
          `?limit=2&cursor=${encodeURIComponent(page2.nextCursor ?? '')}`,
        )
      ).json()) as { customers: { name: string }[]; nextCursor: string | null };
      expect(page3.customers.map((c) => c.name)).toEqual(['C1']);
      expect(page3.nextCursor).toBeNull();
    } finally {
      await handle.close();
    }
  });

  it('keeps the keyset stable when a newer row is inserted mid-walk', async () => {
    const { app, handle } = buildApp();
    try {
      const ctx = await setup(app, 'stable@example.com');
      for (const n of ['C1', 'C2', 'C3', 'C4', 'C5']) {
        expect((await createCustomer(app, ctx, n)).status).toBe(201);
      }

      const page1 = (await (await getCustomers(app, ctx, '?limit=2')).json()) as {
        customers: { name: string }[];
        nextCursor: string | null;
      };
      expect(page1.customers.map((c) => c.name)).toEqual(['C5', 'C4']);

      // Insert a brand-new row after page 1 was read. Because the cursor is
      // anchored to C4, C6 (newer) must not appear and nothing is skipped.
      expect((await createCustomer(app, ctx, 'C6')).status).toBe(201);

      const page2 = (await (
        await getCustomers(
          app,
          ctx,
          `?limit=2&cursor=${encodeURIComponent(page1.nextCursor ?? '')}`,
        )
      ).json()) as { customers: { name: string }[] };
      expect(page2.customers.map((c) => c.name)).toEqual(['C3', 'C2']);
    } finally {
      await handle.close();
    }
  });

  it('400s a malformed cursor and a malformed limit', async () => {
    const { app, handle } = buildApp();
    try {
      const ctx = await setup(app, 'bad@example.com');
      expect((await getCustomers(app, ctx, '?cursor=not-a-real-cursor')).status).toBe(400);
      expect((await getCustomers(app, ctx, '?limit=0')).status).toBe(400);
      expect((await getCustomers(app, ctx, '?limit=abc')).status).toBe(400);
    } finally {
      await handle.close();
    }
  });
});

describe('GET /api/items — keyset pagination (alphabetical, asc)', () => {
  beforeEach(resetDb);

  function createItem(app: ReturnType<typeof createApp>, ctx: Ctx, name: string) {
    return app.request('/api/items', {
      method: 'POST',
      headers: {
        cookie: ctx.cookie,
        'x-account-id': ctx.accountId,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ companyId: ctx.companyId, name }),
    });
  }

  it('pages name-ascending and ends with null', async () => {
    const { app, handle } = buildApp();
    try {
      const ctx = await setup(app, 'itempager@example.com');
      // Insert out of order; the list must come back alphabetical.
      for (const n of ['Banana', 'Apple', 'Cherry']) {
        expect((await createItem(app, ctx, n)).status).toBe(201);
      }

      const page1 = (await (
        await app.request('/api/items?limit=2', {
          headers: { cookie: ctx.cookie, 'x-account-id': ctx.accountId },
        })
      ).json()) as { items: { name: string }[]; nextCursor: string | null };
      expect(page1.items.map((i) => i.name)).toEqual(['Apple', 'Banana']);
      expect(page1.nextCursor).toBeTruthy();

      const page2 = (await (
        await app.request(
          `/api/items?limit=2&cursor=${encodeURIComponent(page1.nextCursor ?? '')}`,
          { headers: { cookie: ctx.cookie, 'x-account-id': ctx.accountId } },
        )
      ).json()) as { items: { name: string }[]; nextCursor: string | null };
      expect(page2.items.map((i) => i.name)).toEqual(['Cherry']);
      expect(page2.nextCursor).toBeNull();
    } finally {
      await handle.close();
    }
  });
});

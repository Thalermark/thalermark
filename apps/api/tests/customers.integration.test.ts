import { auditEvents, authUser, companies, customers, memberships } from '@thalermark/db';
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
  if (!m) throw new Error(`membership for ${email} not seeded by hook`);
  const [company] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.accountId, m.accountId));
  if (!company) throw new Error(`default company for ${email} not seeded by hook`);
  return { userId: user.id, accountId: m.accountId, companyId: company.id };
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

describe('GET /api/companies', () => {
  beforeEach(resetDb);

  it('returns the active account default company after signup', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'alice@example.com');
      const { accountId, companyId } = await userContext('alice@example.com');
      const res = await app.request('/api/companies', {
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        companies: { id: string; name: string; businessType: string | null }[];
      };
      expect(body.companies).toHaveLength(1);
      expect(body.companies[0]?.id).toBe(companyId);
      expect(body.companies[0]?.name).toBe('alice@example.com');
      expect(body.companies[0]?.businessType).toBeNull();
    } finally {
      await handle.close();
    }
  });
});

describe('PATCH /api/companies/:id', () => {
  beforeEach(resetDb);

  it('writes name + businessType and an audit row', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'patcher@example.com');
      const { accountId, companyId } = await userContext('patcher@example.com');
      const res = await app.request(`/api/companies/${companyId}`, {
        method: 'PATCH',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Acme LLC', businessType: 'llc_single_member' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        id: string;
        name: string;
        businessType: string;
      };
      expect(body.name).toBe('Acme LLC');
      expect(body.businessType).toBe('llc_single_member');

      const db = getTestDb();
      const [row] = await db.select().from(companies).where(eq(companies.id, companyId));
      expect(row?.businessType).toBe('llc_single_member');

      const audits = await db.select().from(auditEvents).where(eq(auditEvents.entityId, companyId));
      const update = audits.find((a) => a.action === 'update');
      expect(update).toBeDefined();
      expect(update?.before).toMatchObject({ businessType: null });
      expect(update?.after).toMatchObject({ businessType: 'llc_single_member', name: 'Acme LLC' });
    } finally {
      await handle.close();
    }
  });

  it('accepts a businessType-only sparse PATCH (leaves name alone)', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'sparse@example.com');
      const { accountId, companyId } = await userContext('sparse@example.com');
      const res = await app.request(`/api/companies/${companyId}`, {
        method: 'PATCH',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({ businessType: 's_corp' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { name: string; businessType: string };
      expect(body.name).toBe('sparse@example.com');
      expect(body.businessType).toBe('s_corp');
    } finally {
      await handle.close();
    }
  });

  it('rejects an empty body with 400', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'empty@example.com');
      const { accountId, companyId } = await userContext('empty@example.com');
      const res = await app.request(`/api/companies/${companyId}`, {
        method: 'PATCH',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    } finally {
      await handle.close();
    }
  });

  it('rejects an unknown businessType with 400', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'bad-type@example.com');
      const { accountId, companyId } = await userContext('bad-type@example.com');
      const res = await app.request(`/api/companies/${companyId}`, {
        method: 'PATCH',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({ businessType: 'partnership_general' }),
      });
      expect(res.status).toBe(400);
    } finally {
      await handle.close();
    }
  });

  it('404s a company that belongs to a different account', async () => {
    const { app, handle } = buildApp();
    try {
      await signUp(app, 'a@example.com');
      const a = await userContext('a@example.com');

      const bCookie = await signUp(app, 'b@example.com');
      const b = await userContext('b@example.com');

      const res = await app.request(`/api/companies/${a.companyId}`, {
        method: 'PATCH',
        headers: {
          cookie: bCookie,
          'x-account-id': b.accountId,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ businessType: 'sole_prop' }),
      });
      expect(res.status).toBe(404);
    } finally {
      await handle.close();
    }
  });
});

describe('POST /api/customers', () => {
  beforeEach(resetDb);

  it('creates a customer and writes an audit row', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'bob@example.com');
      const { accountId, companyId } = await userContext('bob@example.com');

      const res = await app.request('/api/customers', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({
          companyId,
          name: 'Wile E. Coyote',
          email: 'wile@example.com',
          city: 'Tucson',
          country: 'US',
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string; name: string; companyId: string };
      expect(body.name).toBe('Wile E. Coyote');
      expect(body.companyId).toBe(companyId);

      const db = getTestDb();
      const rows = await db.select().from(customers).where(eq(customers.id, body.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.accountId).toBe(accountId);
      expect(rows[0]?.email).toBe('wile@example.com');
    } finally {
      await handle.close();
    }
  });

  it('rejects a malformed body with 400', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'carol@example.com');
      const { accountId, companyId } = await userContext('carol@example.com');
      const res = await app.request('/api/customers', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({ companyId, name: '' }),
      });
      expect(res.status).toBe(400);
    } finally {
      await handle.close();
    }
  });

  it('rejects a companyId belonging to a different account with 404', async () => {
    const { app, handle } = buildApp();
    try {
      await signUp(app, 'dan@example.com');
      const danCtx = await userContext('dan@example.com');
      const ericCookie = await signUp(app, 'eric@example.com');
      const ericCtx = await userContext('eric@example.com');

      const res = await app.request('/api/customers', {
        method: 'POST',
        headers: {
          cookie: ericCookie,
          'x-account-id': ericCtx.accountId,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ companyId: danCtx.companyId, name: 'Cross-tenant' }),
      });
      expect(res.status).toBe(404);
    } finally {
      await handle.close();
    }
  });

  it('refuses unauthed requests', async () => {
    const { app, handle } = buildApp();
    try {
      const res = await app.request('/api/customers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ companyId: 'x', name: 'y' }),
      });
      expect(res.status).toBe(401);
    } finally {
      await handle.close();
    }
  });
});

describe('GET /api/customers', () => {
  beforeEach(resetDb);

  it('lists only the active account customers (RLS)', async () => {
    const { app, handle } = buildApp();
    try {
      const aCookie = await signUp(app, 'alice-a@example.com');
      const aCtx = await userContext('alice-a@example.com');
      const bCookie = await signUp(app, 'bob-b@example.com');
      const bCtx = await userContext('bob-b@example.com');

      await app.request('/api/customers', {
        method: 'POST',
        headers: {
          cookie: aCookie,
          'x-account-id': aCtx.accountId,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ companyId: aCtx.companyId, name: 'A Customer' }),
      });
      await app.request('/api/customers', {
        method: 'POST',
        headers: {
          cookie: bCookie,
          'x-account-id': bCtx.accountId,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ companyId: bCtx.companyId, name: 'B Customer' }),
      });

      const res = await app.request('/api/customers', {
        headers: { cookie: aCookie, 'x-account-id': aCtx.accountId },
      });
      const body = (await res.json()) as { customers: { name: string }[] };
      expect(body.customers).toHaveLength(1);
      expect(body.customers[0]?.name).toBe('A Customer');
    } finally {
      await handle.close();
    }
  });
});

describe('GET /api/customers/:id', () => {
  beforeEach(resetDb);

  it('returns 404 for a customer in another account', async () => {
    const { app, handle } = buildApp();
    try {
      const aCookie = await signUp(app, 'alice2@example.com');
      const aCtx = await userContext('alice2@example.com');
      const bCookie = await signUp(app, 'bob2@example.com');
      const bCtx = await userContext('bob2@example.com');

      const create = await app.request('/api/customers', {
        method: 'POST',
        headers: {
          cookie: aCookie,
          'x-account-id': aCtx.accountId,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ companyId: aCtx.companyId, name: 'A Only' }),
      });
      const { id } = (await create.json()) as { id: string };

      const res = await app.request(`/api/customers/${id}`, {
        headers: { cookie: bCookie, 'x-account-id': bCtx.accountId },
      });
      expect(res.status).toBe(404);
    } finally {
      await handle.close();
    }
  });

  it('returns 400 for a malformed uuid', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'frank@example.com');
      const { accountId } = await userContext('frank@example.com');
      const res = await app.request('/api/customers/not-a-uuid', {
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(res.status).toBe(400);
    } finally {
      await handle.close();
    }
  });
});

describe('PATCH /api/customers/:id', () => {
  beforeEach(resetDb);

  async function seedCustomer(
    app: ReturnType<typeof createApp>,
    email: string,
  ): Promise<{ cookie: string; accountId: string; companyId: string; customerId: string }> {
    const cookie = await signUp(app, email);
    const { accountId, companyId } = await userContext(email);
    const create = await app.request('/api/customers', {
      method: 'POST',
      headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
      body: JSON.stringify({
        companyId,
        name: 'Original Name',
        email: 'orig@example.com',
        city: 'Tucson',
      }),
    });
    if (create.status !== 201) throw new Error(`seed customer failed: ${create.status}`);
    const { id } = (await create.json()) as { id: string };
    return { cookie, accountId, companyId, customerId: id };
  }

  it('replaces fields and writes an update audit row', async () => {
    const { app, handle } = buildApp();
    try {
      const { cookie, accountId, companyId, customerId } = await seedCustomer(
        app,
        'patcher@example.com',
      );
      const res = await app.request(`/api/customers/${customerId}`, {
        method: 'PATCH',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Renamed Coyote',
          email: 'new@example.com',
          city: 'Phoenix',
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        name: string;
        email: string | null;
        phone: string | null;
        city: string | null;
        companyId: string;
      };
      expect(body.name).toBe('Renamed Coyote');
      expect(body.email).toBe('new@example.com');
      expect(body.city).toBe('Phoenix');
      // Field omitted on the second submit was on the original (phone: null)
      // — still null, no change to the prior absent state.
      expect(body.phone).toBeNull();
      expect(body.companyId).toBe(companyId);

      const db = getTestDb();
      const audits = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.entityId, customerId));
      expect(audits.map((a) => a.action).sort()).toEqual(['create', 'update']);
      const update = audits.find((a) => a.action === 'update');
      expect(update?.before).toMatchObject({ name: 'Original Name' });
      expect(update?.after).toMatchObject({ name: 'Renamed Coyote' });
    } finally {
      await handle.close();
    }
  });

  it('clears optional fields when omitted on the next submit', async () => {
    const { app, handle } = buildApp();
    try {
      const { cookie, accountId, customerId } = await seedCustomer(app, 'clear@example.com');
      const res = await app.request(`/api/customers/${customerId}`, {
        method: 'PATCH',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Only Name' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { email: string | null; city: string | null };
      expect(body.email).toBeNull();
      expect(body.city).toBeNull();
    } finally {
      await handle.close();
    }
  });

  it('rejects a malformed body with 400', async () => {
    const { app, handle } = buildApp();
    try {
      const { cookie, accountId, customerId } = await seedCustomer(app, 'bad@example.com');
      const res = await app.request(`/api/customers/${customerId}`, {
        method: 'PATCH',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({ name: '' }),
      });
      expect(res.status).toBe(400);
    } finally {
      await handle.close();
    }
  });

  it('returns 404 for a cross-tenant customer id', async () => {
    const { app, handle } = buildApp();
    try {
      const a = await seedCustomer(app, 'tenant-a@example.com');
      const bCookie = await signUp(app, 'tenant-b@example.com');
      const bCtx = await userContext('tenant-b@example.com');
      const res = await app.request(`/api/customers/${a.customerId}`, {
        method: 'PATCH',
        headers: {
          cookie: bCookie,
          'x-account-id': bCtx.accountId,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Hijack' }),
      });
      expect(res.status).toBe(404);
    } finally {
      await handle.close();
    }
  });
});

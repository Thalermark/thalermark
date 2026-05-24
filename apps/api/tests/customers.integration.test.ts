import { authUser, companies, customers, memberships } from '@thalermark/db';
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
      const body = (await res.json()) as { companies: { id: string; name: string }[] };
      expect(body.companies).toHaveLength(1);
      expect(body.companies[0]?.id).toBe(companyId);
      expect(body.companies[0]?.name).toBe('alice@example.com');
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

import { SYSTEM_USER_ID, auditEvents, authUser, companies, memberships } from '@thalermark/db';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
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
  resendApiKey: undefined,
  emailFrom: 'Thalermark <test@thalermark.test>',
  stripeSecretKey: undefined,
  stripePublishableKey: undefined,
  stripeWebhookSecret: undefined,
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
    emailFrom: 'Thalermark <test@thalermark.test>',
  });
  return { app, handle };
}

async function createCustomer(
  app: ReturnType<typeof createApp>,
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

describe('GET /api/audit-events', () => {
  beforeEach(resetDb);

  it('returns audit rows for the entity, newest first, with actor name resolved', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'audithist@example.com');
      const { userId, accountId, companyId } = await userContext('audithist@example.com');
      const customerId = await createCustomer(ctx.app, cookie, accountId, companyId);

      // Trigger an update so the customer has 2 audit rows (create + update).
      const patchRes = await ctx.app.request(`/api/customers/${customerId}`, {
        method: 'PATCH',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({ companyId, name: 'Wile E. Coyote Jr.' }),
      });
      expect(patchRes.status).toBe(200);

      const res = await ctx.app.request(
        `/api/audit-events?entityType=customer&entityId=${customerId}`,
        { headers: { cookie, 'x-account-id': accountId } },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        events: { id: string; action: string; actorName: string; createdAt: string }[];
      };
      expect(body.events).toHaveLength(2);
      // newest first → update before create
      expect(body.events[0]?.action).toBe('update');
      expect(body.events[1]?.action).toBe('create');
      // actor resolved to display name (signupEmail used as name)
      expect(body.events[0]?.actorName).toBe('audithist@example.com');
      // userId not leaked to the consumer
      expect(body.events[0] as Record<string, unknown>).not.toHaveProperty('actorUserId');
      // sanity: the resolved name matches the real user id
      const db = getTestDb();
      const [u] = await db
        .select({ name: authUser.name })
        .from(authUser)
        .where(eq(authUser.id, userId));
      expect(u?.name).toBe('audithist@example.com');
    } finally {
      await ctx.handle.close();
    }
  });

  it('returns System for rows attributed to the synthetic system user', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'auditsys@example.com');
      const { accountId, companyId } = await userContext('auditsys@example.com');
      const customerId = await createCustomer(ctx.app, cookie, accountId, companyId);

      // Insert a system-attributed audit row directly — same pattern Stripe
      // webhook + public estimate accept/decline use in production.
      const db = getTestDb();
      await db.insert(auditEvents).values({
        id: uuidv7(),
        accountId,
        companyId,
        actorUserId: SYSTEM_USER_ID,
        entityType: 'customer',
        entityId: customerId,
        action: 'stripe-paid',
        after: { status: 'paid' },
      });

      const res = await ctx.app.request(
        `/api/audit-events?entityType=customer&entityId=${customerId}`,
        { headers: { cookie, 'x-account-id': accountId } },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        events: { action: string; actorName: string }[];
      };
      const sys = body.events.find((e) => e.action === 'stripe-paid');
      expect(sys?.actorName).toBe('System');
    } finally {
      await ctx.handle.close();
    }
  });

  it("does not return another account's audit rows", async () => {
    const ctx = buildApp();
    try {
      // Account A creates a customer
      const aCookie = await signUp(ctx.app, 'auditxa@example.com');
      const aCtx = await userContext('auditxa@example.com');
      const aCustomer = await createCustomer(ctx.app, aCookie, aCtx.accountId, aCtx.companyId);

      // Account B queries A's customer id → empty events list, not a leak
      const bCookie = await signUp(ctx.app, 'auditxb@example.com');
      const bCtx = await userContext('auditxb@example.com');
      const res = await ctx.app.request(
        `/api/audit-events?entityType=customer&entityId=${aCustomer}`,
        { headers: { cookie: bCookie, 'x-account-id': bCtx.accountId } },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { events: unknown[] };
      expect(body.events).toEqual([]);
    } finally {
      await ctx.handle.close();
    }
  });

  it('rejects an unknown entityType with 400', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'auditbad@example.com');
      const { accountId } = await userContext('auditbad@example.com');
      const someUuid = uuidv7();
      const res = await ctx.app.request(
        `/api/audit-events?entityType=expense&entityId=${someUuid}`,
        { headers: { cookie, 'x-account-id': accountId } },
      );
      expect(res.status).toBe(400);
      expect((await res.json()) as { error: string }).toEqual({ error: 'invalid_entity_type' });
    } finally {
      await ctx.handle.close();
    }
  });

  it('rejects a malformed entityId with 400', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'auditbadid@example.com');
      const { accountId } = await userContext('auditbadid@example.com');
      const res = await ctx.app.request(
        '/api/audit-events?entityType=invoice&entityId=not-a-uuid',
        { headers: { cookie, 'x-account-id': accountId } },
      );
      expect(res.status).toBe(400);
      expect((await res.json()) as { error: string }).toEqual({ error: 'invalid_entity_id' });
    } finally {
      await ctx.handle.close();
    }
  });
});

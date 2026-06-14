import { auditEvents, authUser, companies, memberships, taxPolicies } from '@thalermark/db';
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

type PolicyBody = { companyId: string; name: string; ratePct?: string; isDefault?: boolean };

function createPolicy(
  app: ReturnType<typeof createApp>,
  ctx: { cookie: string; accountId: string },
  body: PolicyBody,
) {
  return app.request('/api/tax-policies', {
    method: 'POST',
    headers: {
      cookie: ctx.cookie,
      'x-account-id': ctx.accountId,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/tax-policies', () => {
  beforeEach(resetDb);

  it('creates a policy with defaults and writes an audit row', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'tp-bob@example.com');
      const { accountId, companyId } = await userContext('tp-bob@example.com');

      const res = await createPolicy(app, { cookie, accountId }, { companyId, name: 'General' });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string; name: string };
      expect(body.name).toBe('General');

      const db = getTestDb();
      const [row] = await db.select().from(taxPolicies).where(eq(taxPolicies.id, body.id));
      expect(row?.accountId).toBe(accountId);
      expect(row?.ratePct).toBe('0.0000');
      expect(row?.isDefault).toBe(false);
      expect(row?.archivedAt).toBeNull();

      const audits = await db.select().from(auditEvents).where(eq(auditEvents.entityId, body.id));
      expect(audits.map((a) => a.action)).toEqual(['create']);
      expect(audits[0]?.entityType).toBe('tax_policy');
    } finally {
      await handle.close();
    }
  });

  it('stores a rate and default flag', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'tp-full@example.com');
      const { accountId, companyId } = await userContext('tp-full@example.com');
      const res = await createPolicy(
        app,
        { cookie, accountId },
        { companyId, name: 'Sales Tax', ratePct: '8.25', isDefault: true },
      );
      expect(res.status).toBe(201);
      const { id } = (await res.json()) as { id: string };

      const db = getTestDb();
      const [row] = await db.select().from(taxPolicies).where(eq(taxPolicies.id, id));
      expect(row?.ratePct).toBe('8.2500');
      expect(row?.isDefault).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it('enforces a single default per company — a new default clears the prior one', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'tp-default@example.com');
      const { accountId, companyId } = await userContext('tp-default@example.com');

      const a = await createPolicy(
        app,
        { cookie, accountId },
        { companyId, name: 'A', ratePct: '8.25', isDefault: true },
      );
      const aId = ((await a.json()) as { id: string }).id;
      await createPolicy(
        app,
        { cookie, accountId },
        { companyId, name: 'B', ratePct: '5.00', isDefault: true },
      );

      const db = getTestDb();
      const [aRow] = await db.select().from(taxPolicies).where(eq(taxPolicies.id, aId));
      expect(aRow?.isDefault).toBe(false);
      const defaults = (
        await db.select().from(taxPolicies).where(eq(taxPolicies.companyId, companyId))
      ).filter((r) => r.isDefault);
      expect(defaults).toHaveLength(1);
      expect(defaults[0]?.name).toBe('B');
    } finally {
      await handle.close();
    }
  });

  it('rejects a rate over 100 with 400', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'tp-bad@example.com');
      const { accountId, companyId } = await userContext('tp-bad@example.com');
      const res = await createPolicy(
        app,
        { cookie, accountId },
        { companyId, name: 'Typo', ratePct: '825' },
      );
      expect(res.status).toBe(400);
    } finally {
      await handle.close();
    }
  });

  it('refuses unauthed requests', async () => {
    const { app, handle } = buildApp();
    try {
      const res = await app.request('/api/tax-policies', {
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

describe('GET /api/tax-policies', () => {
  beforeEach(resetDb);

  it('lists only the active account policies (RLS), ordered by name', async () => {
    const { app, handle } = buildApp();
    try {
      const aCookie = await signUp(app, 'tp-alice@example.com');
      const aCtx = await userContext('tp-alice@example.com');
      const bCookie = await signUp(app, 'tp-bob2@example.com');
      const bCtx = await userContext('tp-bob2@example.com');

      await createPolicy(
        app,
        { cookie: aCookie, accountId: aCtx.accountId },
        {
          companyId: aCtx.companyId,
          name: 'Reduced',
        },
      );
      await createPolicy(
        app,
        { cookie: aCookie, accountId: aCtx.accountId },
        {
          companyId: aCtx.companyId,
          name: 'General',
        },
      );
      await createPolicy(
        app,
        { cookie: bCookie, accountId: bCtx.accountId },
        {
          companyId: bCtx.companyId,
          name: 'B-only',
        },
      );

      const res = await app.request('/api/tax-policies', {
        headers: { cookie: aCookie, 'x-account-id': aCtx.accountId },
      });
      const body = (await res.json()) as { taxPolicies: { name: string }[] };
      expect(body.taxPolicies.map((p) => p.name)).toEqual(['General', 'Reduced']);
    } finally {
      await handle.close();
    }
  });

  it('hides archived policies by default, includes them with includeArchived=true', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'tp-arch@example.com');
      const { accountId, companyId } = await userContext('tp-arch@example.com');
      const create = await createPolicy(
        app,
        { cookie, accountId },
        { companyId, name: 'Old rate' },
      );
      const { id } = (await create.json()) as { id: string };

      const archived = await app.request(`/api/tax-policies/${id}/archive`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(archived.status).toBe(200);

      const def = await app.request('/api/tax-policies', {
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(((await def.json()) as { taxPolicies: unknown[] }).taxPolicies).toHaveLength(0);

      const withArchived = await app.request('/api/tax-policies?includeArchived=true', {
        headers: { cookie, 'x-account-id': accountId },
      });
      const body = (await withArchived.json()) as { taxPolicies: { id: string }[] };
      expect(body.taxPolicies).toHaveLength(1);
    } finally {
      await handle.close();
    }
  });
});

describe('PATCH /api/tax-policies/:id', () => {
  beforeEach(resetDb);

  it('replaces fields and writes an update audit row', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'tp-patch@example.com');
      const { accountId, companyId } = await userContext('tp-patch@example.com');
      const create = await createPolicy(
        app,
        { cookie, accountId },
        { companyId, name: 'Original', ratePct: '8.25', isDefault: true },
      );
      const { id } = (await create.json()) as { id: string };

      const res = await app.request(`/api/tax-policies/${id}`, {
        method: 'PATCH',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed', ratePct: '6.5' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { name: string; ratePct: string; isDefault: boolean };
      expect(body.name).toBe('Renamed');
      expect(body.ratePct).toBe('6.5000');
      // isDefault omitted -> collapses to its column default (full-replacement).
      expect(body.isDefault).toBe(false);

      const db = getTestDb();
      const audits = await db.select().from(auditEvents).where(eq(auditEvents.entityId, id));
      expect(audits.map((a) => a.action).sort()).toEqual(['create', 'update']);
    } finally {
      await handle.close();
    }
  });

  it('returns 404 for a cross-tenant policy id', async () => {
    const { app, handle } = buildApp();
    try {
      const aCookie = await signUp(app, 'tp-owner@example.com');
      const aCtx = await userContext('tp-owner@example.com');
      const bCookie = await signUp(app, 'tp-intruder@example.com');
      const bCtx = await userContext('tp-intruder@example.com');
      const create = await createPolicy(
        app,
        { cookie: aCookie, accountId: aCtx.accountId },
        {
          companyId: aCtx.companyId,
          name: 'Owned',
        },
      );
      const { id } = (await create.json()) as { id: string };

      const res = await app.request(`/api/tax-policies/${id}`, {
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

describe('POST /api/tax-policies/:id/archive + /restore', () => {
  beforeEach(resetDb);

  it('archiving the default policy clears its is_default flag', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'tp-arch-default@example.com');
      const { accountId, companyId } = await userContext('tp-arch-default@example.com');
      const create = await createPolicy(
        app,
        { cookie, accountId },
        { companyId, name: 'Default rate', ratePct: '8.25', isDefault: true },
      );
      const { id } = (await create.json()) as { id: string };

      const archive = await app.request(`/api/tax-policies/${id}/archive`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(archive.status).toBe(200);
      const body = (await archive.json()) as { archivedAt: string | null; isDefault: boolean };
      expect(body.archivedAt).not.toBeNull();
      expect(body.isDefault).toBe(false);
    } finally {
      await handle.close();
    }
  });
});

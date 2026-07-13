import { accounts, authUser, companies, memberships } from '@thalermark/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// Workspace-name mirror. At signup both accounts.name (the "Workspace") and the
// first company were seeded with the person's name; the onboarding wizard then
// renames only the company. So PATCH /api/companies/:id propagates a rename to
// accounts.name — but only for a single-company (solo) workspace, never for a
// multi-company one (no single business to mirror). See routes/companies.ts.

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

// signUp seeds account + first company both named after `name` (the person).
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

async function accountName(accountId: string): Promise<string> {
  const [row] = await getTestDb()
    .select({ name: accounts.name })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  if (!row) throw new Error(`account ${accountId} not found`);
  return row.name;
}

describe('PATCH /api/companies/:id — workspace name mirror', () => {
  it('renaming the only company renames the workspace', async () => {
    await resetDb();
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'solo@example.com');
      const { accountId, companyId } = await userContext('solo@example.com');
      expect(await accountName(accountId)).toBe('solo@example.com');

      const res = await ctx.app.request(`/api/companies/${companyId}`, {
        method: 'PATCH',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Acme Landscaping' }),
      });
      expect(res.status).toBe(200);

      expect(await accountName(accountId)).toBe('Acme Landscaping');
    } finally {
      await ctx.handle.close();
    }
  });

  it('renaming one of several companies leaves the workspace name alone', async () => {
    await resetDb();
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'multi@example.com');
      const { accountId, companyId } = await userContext('multi@example.com');

      // A second company makes this a multi-company workspace.
      const created = await ctx.app.request('/api/companies', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Second Biz', businessType: 'sole_prop' }),
      });
      expect(created.status).toBe(201);

      const res = await ctx.app.request(`/api/companies/${companyId}`, {
        method: 'PATCH',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed First' }),
      });
      expect(res.status).toBe(200);

      // Unchanged — no single business to mirror onto the shared workspace.
      expect(await accountName(accountId)).toBe('multi@example.com');
    } finally {
      await ctx.handle.close();
    }
  });
});

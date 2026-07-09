import type { AccountCreatedContext } from '@thalermark/auth';
import { accounts, authUser, memberships } from '@thalermark/db';
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// Open-core onAccountCreated seam, at the createApiAuth layer (the wrapper the
// running API actually constructs auth with). @thalermark/auth already tests the
// hook on createAuth directly; this proves the api wrapper THREADS an injected
// hook through — the pass-through that was previously walled off. A commercial
// composition root supplies the hook to provision an account's trial row; the
// public build (server.ts) passes none, so the hook stays undefined and signup
// is byte-identical.

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

// hook omitted → createApiAuth passes no onAccountCreated (the community
// default: nothing runs at signup).
function buildApp(onAccountCreated?: (ctx: AccountCreatedContext) => Promise<void>) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const handle = createApiDatabase(appDatabaseUrl());
  const auth = createApiAuth(
    getTestDb(),
    { ...testEnv, databaseUrl: url },
    undefined,
    onAccountCreated ? { onAccountCreated } : undefined,
  );
  const app = createApp({ auth, db: handle.db, bootstrapDb: getTestDb() });
  return { app, handle };
}

function signUp(app: ReturnType<typeof createApp>, email: string) {
  return app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct horse battery staple', name: 'Hook User' }),
  });
}

describe('createApiAuth — onAccountCreated seam pass-through', () => {
  beforeEach(resetDb);

  it('forwards an injected hook: it fires on fresh signup, inside the live tx', async () => {
    const db = getTestDb();
    const calls: Array<{ accountId: string; ownerUserId: string; txSeesAccount: boolean }> = [];
    const ctx = buildApp(async ({ accountId, ownerUserId, tx }) => {
      // The tx already sees the account this signup just inserted, proving the
      // forwarded hook runs INSIDE the provisioning transaction, not after it.
      const rows = await tx
        .select({ id: accounts.id })
        .from(accounts)
        .where(eq(accounts.id, accountId));
      calls.push({ accountId, ownerUserId, txSeesAccount: rows.length === 1 });
    });
    try {
      const res = await signUp(ctx.app, 'threaded@example.com');
      expect(res.status).toBe(200);

      const [user] = await db
        .select({ id: authUser.id })
        .from(authUser)
        .where(eq(authUser.email, 'threaded@example.com'));
      if (!user) throw new Error('user not seeded');
      const [membership] = await db
        .select({ accountId: memberships.accountId })
        .from(memberships)
        .where(eq(memberships.userId, user.id));

      expect(calls).toHaveLength(1);
      expect(calls[0]?.accountId).toBe(membership?.accountId);
      expect(calls[0]?.ownerUserId).toBe(user.id);
      expect(calls[0]?.txSeesAccount).toBe(true);
    } finally {
      await ctx.handle.close();
    }
  });

  it('a throwing forwarded hook rolls the signup provisioning back', async () => {
    const db = getTestDb();
    const ctx = buildApp(async () => {
      throw new Error('commercial provisioning failed');
    });
    try {
      await signUp(ctx.app, 'rollback@example.com');

      // The account/company/membership/COA inserts share the hook's transaction,
      // so a throw leaves NO account behind — atomic provisioning. (Better Auth
      // commits auth_user before the after-hook, so that row may survive; the
      // user simply ends up with no account, as any provisioning failure would.)
      const acctCount = await db.select({ n: sql<number>`count(*)::int` }).from(accounts);
      expect(acctCount[0]?.n).toBe(0);
    } finally {
      await ctx.handle.close();
    }
  });

  it('the community default (no hook) provisions the account normally', async () => {
    const db = getTestDb();
    const ctx = buildApp();
    try {
      const res = await signUp(ctx.app, 'nohook@example.com');
      expect(res.status).toBe(200);

      // No hook injected → signup runs exactly as the public build does: the
      // account is provisioned, nothing extra fires.
      const acctCount = await db.select({ n: sql<number>`count(*)::int` }).from(accounts);
      expect(acctCount[0]?.n).toBe(1);
    } finally {
      await ctx.handle.close();
    }
  });
});

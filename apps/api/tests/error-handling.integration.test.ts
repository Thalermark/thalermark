import * as Sentry from '@sentry/node';
import { accounts, authUser, memberships } from '@thalermark/db';
import { eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  publicAppUrl: '',
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
    body: JSON.stringify({ email, password: 'correct horse battery staple', name: 'Test' }),
  });
  if (res.status !== 200) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  return extractSessionCookie(res);
}

async function seedAccountAndMembership(userId: string): Promise<string> {
  const db = getTestDb();
  const accountId = uuidv7();
  await db.insert(accounts).values({ id: accountId, name: 'Test Account' });
  await db.insert(memberships).values({ id: uuidv7(), userId, accountId });
  return accountId;
}

function buildApp() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const handle = createApiDatabase(appDatabaseUrl());
  const auth = createApiAuth(getTestDb(), { ...testEnv, databaseUrl: url });
  const app = createApp({ auth, db: handle.db, bootstrapDb: getTestDb() });
  // Test-only routes that exercise the global error handler. Live under the
  // /api/__test/ prefix so they go through the same cors + rlsContext stack a
  // real handler does (and never collide with a real route — first-match).
  app.get('/api/__test/boom', () => {
    throw new Error('kaboom');
  });
  app.get('/api/__test/http-boom', () => {
    throw new HTTPException(403, { message: 'nope' });
  });
  return { app, handle };
}

async function authedContext(app: ReturnType<typeof createApp>, email: string) {
  const cookie = await signUp(app, email);
  const [user] = await getTestDb()
    .select({ id: authUser.id })
    .from(authUser)
    .where(eq(authUser.email, email));
  if (!user) throw new Error('user not found');
  const accountId = await seedAccountAndMembership(user.id);
  return { cookie, accountId };
}

describe('global onError → error-tracking bridge', () => {
  // Exercise the real Sentry pipeline rather than mocking it. The suite runs with
  // isolate:false (one shared module registry) and @sentry/node's namespace is
  // non-configurable, so neither vi.mock nor vi.spyOn can intercept the same
  // captureException app.ts holds. Instead we genuinely Sentry.init() with a
  // beforeSend that records the event and returns null (drops it — no network),
  // proving a thrown error actually reaches the tracking pipeline. Default
  // integrations are off so init installs no lingering process-level handlers,
  // and afterEach closes the client so nothing leaks into other test files.
  let captured: Sentry.ErrorEvent[] = [];
  beforeEach(async () => {
    await resetDb();
    captured = [];
    Sentry.init({
      dsn: 'https://test@example.com/1',
      defaultIntegrations: false,
      beforeSend: (event) => {
        captured.push(event);
        return null;
      },
    });
  });
  afterEach(async () => {
    await Sentry.close();
  });

  it('captures a thrown handler error and returns the JSON 500 shape', async () => {
    const { app, handle } = buildApp();
    try {
      const { cookie, accountId } = await authedContext(app, 'boom@example.com');
      const res = await app.request('/api/__test/boom', {
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'internal_server_error' });
      await Sentry.flush(2000);
      expect(captured).toHaveLength(1);
      expect(captured[0]?.exception?.values?.[0]?.value).toBe('kaboom');
    } finally {
      await handle.close();
    }
  });

  it('passes an HTTPException through unchanged and does not capture it', async () => {
    const { app, handle } = buildApp();
    try {
      const { cookie, accountId } = await authedContext(app, 'http-boom@example.com');
      const res = await app.request('/api/__test/http-boom', {
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(res.status).toBe(403);
      await Sentry.flush(2000);
      expect(captured).toHaveLength(0);
    } finally {
      await handle.close();
    }
  });
});

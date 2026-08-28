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

function buildApp(appVersion?: string) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const handle = createApiDatabase(appDatabaseUrl());
  const auth = createApiAuth(getTestDb(), { ...testEnv, databaseUrl: url });
  const app = createApp({ auth, db: handle.db, bootstrapDb: getTestDb(), appVersion });
  return { app, handle };
}

// GET /api/build-info reports the build this api process is running, so
// Settings → About can show it beside the version compiled into the web bundle.
// The three things worth pinning: it is behind a session, it does NOT require a
// tenant context (the build belongs to the deployment, not an account), and it
// reports the value it was given rather than a guess.
describe('GET /api/build-info', () => {
  beforeEach(resetDb);

  it('401s without a session', async () => {
    const { app, handle } = buildApp('v9.9.9');
    try {
      const res = await app.request('/api/build-info');
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    } finally {
      await handle.close();
    }
  });

  it('returns the version to a signed-in user with no x-account-id', async () => {
    // The bootstrap-path assertion. A signed-in user who has not picked an
    // account yet still gets an answer; requiring the header would make an
    // informational page depend on account selection, and would 400 here.
    const { app, handle } = buildApp('v9.9.9');
    try {
      const cookie = await signUp(app, 'build-info@example.com');
      const res = await app.request('/api/build-info', { headers: { cookie } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ version: 'v9.9.9' });
    } finally {
      await handle.close();
    }
  });

  it("answers 'dev' when no version was baked in", async () => {
    // Local runs and a plain `docker build` with no --build-arg. Matches what
    // loadEnv resolves for an unset APP_VERSION, so the two paths agree.
    const { app, handle } = buildApp(undefined);
    try {
      const cookie = await signUp(app, 'build-info-dev@example.com');
      const res = await app.request('/api/build-info', { headers: { cookie } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ version: 'dev' });
    } finally {
      await handle.close();
    }
  });
});

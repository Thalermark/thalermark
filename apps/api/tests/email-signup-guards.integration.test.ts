import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// Disposable-email blocking at signup. The `user.create.before` hook runs in
// every env (only requireEmailVerification is gated off in test), so the block
// is exercisable here directly.

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

function buildApp() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const handle = createApiDatabase(appDatabaseUrl());
  const auth = createApiAuth(getTestDb(), { ...testEnv, databaseUrl: url });
  const app = createApp({ auth, db: handle.db, bootstrapDb: getTestDb() });
  return { app, handle };
}

async function signUp(app: ReturnType<typeof createApp>, email: string) {
  return app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct horse battery staple', name: email }),
  });
}

describe('signup email guards', () => {
  beforeEach(resetDb);

  it('rejects a disposable email domain', async () => {
    const ctx = buildApp();
    try {
      const res = await signUp(ctx.app, 'throwaway@mailinator.com');
      expect(res.ok).toBe(false);
      const body = (await res.text()).toLowerCase();
      expect(body).toContain('disposable');
    } finally {
      await ctx.handle.close();
    }
  });

  it('accepts a normal email domain', async () => {
    const ctx = buildApp();
    try {
      const res = await signUp(ctx.app, 'real-person@example.com');
      expect(res.status).toBe(200);
    } finally {
      await ctx.handle.close();
    }
  });
});

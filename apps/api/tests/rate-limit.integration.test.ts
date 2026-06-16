import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// Better Auth's built-in request rate limiting, backed by the auth_rate_limit
// table (storage:'database'). The api enables it in production via
// RATE_LIMIT_ENABLED; here we force it on to exercise the /sign-in/email
// customRule (10 / 60s). Keying is per IP + path — we send a stable
// x-forwarded-for so all attempts share a counter (the same header Caddy
// forwards in production; in dev/test BA falls back to a localhost IP).

const baseEnv: Env = {
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

function buildApp(rateLimitEnabled: boolean) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const handle = createApiDatabase(appDatabaseUrl());
  const auth = createApiAuth(getTestDb(), { ...baseEnv, databaseUrl: url, rateLimitEnabled });
  const app = createApp({ auth, db: handle.db, bootstrapDb: getTestDb() });
  return { app, handle };
}

// Fire the same failed sign-in N times from one IP; return each status code.
async function hammerSignIn(app: ReturnType<typeof createApp>, n: number): Promise<number[]> {
  const headers = { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' };
  const body = JSON.stringify({ email: 'attacker-target@example.com', password: 'guess-guess-1' });
  const statuses: number[] = [];
  for (let i = 0; i < n; i++) {
    const res = await app.request('/api/auth/sign-in/email', { method: 'POST', headers, body });
    statuses.push(res.status);
  }
  return statuses;
}

describe('login rate limiting', () => {
  beforeEach(resetDb);

  it('returns 429 once the /sign-in/email cap (10 / 60s) is exceeded', async () => {
    const ctx = buildApp(true);
    try {
      const statuses = await hammerSignIn(ctx.app, 12);
      // The first 10 attempts get through to the handler (a normal auth
      // failure, never 429); the 11th onward are throttled.
      expect(statuses.slice(0, 10).some((s) => s === 429)).toBe(false);
      expect(statuses.at(-1)).toBe(429);
    } finally {
      await ctx.handle.close();
    }
  });

  it('does not throttle when rate limiting is disabled (dev/test default)', async () => {
    const ctx = buildApp(false);
    try {
      const statuses = await hammerSignIn(ctx.app, 12);
      expect(statuses.some((s) => s === 429)).toBe(false);
    } finally {
      await ctx.handle.close();
    }
  });
});

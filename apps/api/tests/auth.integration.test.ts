import { authUser } from '@thalermark/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { getTestDb, resetDb } from './test-helper.js';

// End-to-end: POST /api/auth/sign-up/email through the real Hono app → BA
// → Drizzle adapter → Postgres. Confirms the wiring in app.ts mounts the
// handler and that sign-up actually persists.

describe('POST /api/auth/sign-up/email', () => {
  beforeEach(resetDb);

  it('creates an auth_user and returns a session cookie', async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL not set');
    const handle = createApiDatabase(url);
    try {
      const auth = createApiAuth(handle.db, {
        nodeEnv: 'test',
        port: 3000,
        logLevel: 'info',
        errorTrackingDsn: undefined,
        release: undefined,
        databaseUrl: url,
        migrateOnBoot: false,
        betterAuthSecret: 'test-secret-at-least-32-characters-long',
        betterAuthUrl: 'http://localhost:3000',
        trustedOrigins: [],
        publicAppUrl: '',
      });
      const app = createApp({ auth, db: handle.db });

      const res = await app.request('/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'api-signup@example.com',
          password: 'correct horse battery staple',
          name: 'API Sign Up',
        }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('set-cookie')).toMatch(/better-auth/);

      const db = getTestDb();
      const rows = await db
        .select()
        .from(authUser)
        .where(eq(authUser.email, 'api-signup@example.com'));
      expect(rows).toHaveLength(1);
    } finally {
      await handle.close();
    }
  });

  // The bearer plugin authenticates a follow-up request via
  // `Authorization: Bearer <set-auth-token>` instead of cookies — the contract
  // mobile (and any non-cookie client) depends on. Web's cookie path is
  // covered by the sign-up assertion above and stays unaffected because the
  // bearer plugin's before-hook is a no-op without an Authorization header.
  it('issues a set-auth-token usable as Bearer credentials on /api/me', async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL not set');
    const handle = createApiDatabase(url);
    try {
      const auth = createApiAuth(handle.db, {
        nodeEnv: 'test',
        port: 3000,
        logLevel: 'info',
        errorTrackingDsn: undefined,
        release: undefined,
        databaseUrl: url,
        migrateOnBoot: false,
        betterAuthSecret: 'test-secret-at-least-32-characters-long',
        betterAuthUrl: 'http://localhost:3000',
        trustedOrigins: [],
        publicAppUrl: '',
      });
      const app = createApp({ auth, db: handle.db });

      const signUp = await app.request('/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'bearer-signup@example.com',
          password: 'correct horse battery staple',
          name: 'Bearer Sign Up',
        }),
      });
      expect(signUp.status).toBe(200);
      const token = signUp.headers.get('set-auth-token');
      expect(token, 'expected bearer plugin to echo session token').toBeTruthy();

      const me = await app.request('/api/me', {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(me.status).toBe(200);
      const body = (await me.json()) as { user: { email: string } };
      expect(body.user.email).toBe('bearer-signup@example.com');
    } finally {
      await handle.close();
    }
  });
});

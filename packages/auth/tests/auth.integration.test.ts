import { authUser } from '@thalermark/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAuth } from '../src/index.js';
import { getTestDb, resetDb } from './test-helper.js';

// Exercises createAuth against a real Postgres + our auth_* schema:
// sign-up writes auth_user, returns a session cookie.

describe('createAuth — email/password sign-up', () => {
  beforeEach(resetDb);

  it('inserts an auth_user row and sets a session cookie', async () => {
    const db = getTestDb();
    const auth = createAuth(db, {
      secret: 'test-secret-at-least-32-characters-long',
      baseURL: 'http://localhost:3000',
    });

    const res = await auth.handler(
      new Request('http://localhost:3000/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'signup@example.com',
          password: 'correct horse battery staple',
          name: 'Sign Up',
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/better-auth/);

    const rows = await db.select().from(authUser).where(eq(authUser.email, 'signup@example.com'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('Sign Up');
  });
});

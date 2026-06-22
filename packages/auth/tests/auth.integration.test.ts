import { accounts, authUser, memberships } from '@thalermark/db';
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

  it('seeds an accounts row + membership via the after-create hook', async () => {
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
          email: 'seeded@example.com',
          password: 'correct horse battery staple',
          name: 'Seeded User',
        }),
      }),
    );
    expect(res.status).toBe(200);

    const [user] = await db.select().from(authUser).where(eq(authUser.email, 'seeded@example.com'));
    expect(user).toBeDefined();
    if (!user) throw new Error('user not seeded');

    const userMemberships = await db
      .select({
        membershipId: memberships.id,
        accountId: memberships.accountId,
        accountName: accounts.name,
      })
      .from(memberships)
      .innerJoin(accounts, eq(memberships.accountId, accounts.id))
      .where(eq(memberships.userId, user.id));
    expect(userMemberships).toHaveLength(1);
    expect(userMemberships[0]?.accountName).toBe('Seeded User');
  });

  it('falls back to the email local-part when name is empty', async () => {
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
          email: 'noname@example.com',
          password: 'correct horse battery staple',
          name: '',
        }),
      }),
    );
    expect(res.status).toBe(200);

    const [user] = await db.select().from(authUser).where(eq(authUser.email, 'noname@example.com'));
    if (!user) throw new Error('user not seeded');
    const rows = await db
      .select({ name: accounts.name })
      .from(memberships)
      .innerJoin(accounts, eq(memberships.accountId, accounts.id))
      .where(eq(memberships.userId, user.id));
    expect(rows[0]?.name).toBe('noname');
  });
});

describe('createAuth — signup password gate', () => {
  beforeEach(resetDb);

  function newAuth() {
    return createAuth(getTestDb(), {
      secret: 'test-secret-at-least-32-characters-long',
      baseURL: 'http://localhost:3000',
    });
  }

  async function attemptSignUp(
    auth: ReturnType<typeof createAuth>,
    email: string,
    password: string,
  ) {
    return auth.handler(
      new Request('http://localhost:3000/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password, name: 'Gate' }),
      }),
    );
  }

  it('rejects a long-but-common password and creates no user', async () => {
    const db = getTestDb();
    // 'usuckballz1' clears the length rule (11 chars) but is on the breach list,
    // so the strength gate must reject it — proving the gate is more than length.
    const res = await attemptSignUp(newAuth(), 'weak@example.com', 'usuckballz1');
    expect(res.status).not.toBe(200);
    const rows = await db.select().from(authUser).where(eq(authUser.email, 'weak@example.com'));
    expect(rows).toHaveLength(0);
  });

  it('rejects a password under the minimum length and creates no user', async () => {
    const db = getTestDb();
    const res = await attemptSignUp(newAuth(), 'short@example.com', 'aB3$xY9');
    expect(res.status).not.toBe(200);
    const rows = await db.select().from(authUser).where(eq(authUser.email, 'short@example.com'));
    expect(rows).toHaveLength(0);
  });
});

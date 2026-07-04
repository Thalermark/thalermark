import { accounts, authUser, invitations, memberships } from '@thalermark/db';
import { eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, describe, expect, it } from 'vitest';
import { type AccountCreatedContext, createAuth } from '../src/index.js';
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

describe('createAuth — onAccountCreated seam', () => {
  beforeEach(resetDb);

  // Seeded by resetDb; used as the invite's required invited_by user.
  const SYSTEM_USER_ID = '00000000-0000-7000-8000-000000000001';

  function authWithHook(onAccountCreated: (ctx: AccountCreatedContext) => Promise<void>) {
    return createAuth(getTestDb(), {
      secret: 'test-secret-at-least-32-characters-long',
      baseURL: 'http://localhost:3000',
      onAccountCreated,
    });
  }

  function signUp(auth: ReturnType<typeof createAuth>, email: string) {
    return auth.handler(
      new Request('http://localhost:3000/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email,
          password: 'correct horse battery staple',
          name: 'Hook User',
        }),
      }),
    );
  }

  it('fires on fresh solo signup with the new account + owner, inside the live tx', async () => {
    const db = getTestDb();
    const calls: Array<{ accountId: string; ownerUserId: string; txSeesAccount: boolean }> = [];
    const auth = authWithHook(async ({ accountId, ownerUserId, tx }) => {
      // The tx is live and already sees the account this signup just inserted,
      // proving the hook runs INSIDE the provisioning transaction (not after it).
      const rows = await tx
        .select({ id: accounts.id })
        .from(accounts)
        .where(eq(accounts.id, accountId));
      calls.push({ accountId, ownerUserId, txSeesAccount: rows.length === 1 });
    });

    const res = await signUp(auth, 'hooked@example.com');
    expect(res.status).toBe(200);

    const [user] = await db.select().from(authUser).where(eq(authUser.email, 'hooked@example.com'));
    if (!user) throw new Error('user not seeded');
    const [membership] = await db
      .select({ accountId: memberships.accountId })
      .from(memberships)
      .where(eq(memberships.userId, user.id));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.accountId).toBe(membership?.accountId);
    expect(calls[0]?.ownerUserId).toBe(user.id);
    expect(calls[0]?.txSeesAccount).toBe(true);
  });

  it('does NOT fire on invited signup (the user joins an existing account)', async () => {
    const db = getTestDb();
    // A pre-existing account with a pending invite for the signing-up email.
    const accountId = uuidv7();
    await db.insert(accounts).values({ id: accountId, name: 'Inviter Co' });
    await db.insert(invitations).values({
      id: uuidv7(),
      accountId,
      email: 'invited@example.com',
      role: 'member',
      token: uuidv7(),
      invitedByUserId: SYSTEM_USER_ID,
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    let fired = false;
    const auth = authWithHook(async () => {
      fired = true;
    });
    const res = await signUp(auth, 'invited@example.com');
    expect(res.status).toBe(200);

    expect(fired).toBe(false);
    // No NEW account was provisioned — only the inviter's remains.
    const allAccounts = await db.select({ id: accounts.id }).from(accounts);
    expect(allAccounts).toHaveLength(1);
    expect(allAccounts[0]?.id).toBe(accountId);
  });

  it('rolls the provisioning transaction back when the hook throws', async () => {
    const db = getTestDb();
    const auth = authWithHook(async () => {
      throw new Error('commercial provisioning failed');
    });

    await signUp(auth, 'rollback@example.com');

    // The account/company/membership/COA inserts share the hook's transaction,
    // so a throw in the hook leaves NO account behind — atomic provisioning.
    // (Better Auth commits auth_user before the after-hook, so that row may
    // survive; the user simply ends up with no account, exactly as any
    // provisioning failure would leave them.)
    const acctCount = await db.select({ n: sql<number>`count(*)::int` }).from(accounts);
    expect(acctCount[0]?.n).toBe(0);
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

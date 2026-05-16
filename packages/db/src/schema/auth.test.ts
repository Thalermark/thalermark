import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, resetDb } from '../../tests/db-test-helper.js';
import { authAccount, authSession, authUser, authVerification } from './auth.js';

const oneHourFromNow = () => new Date(Date.now() + 3_600_000);

describe('auth_user', () => {
  beforeEach(resetDb);

  it('inserts and reads back a user', async () => {
    const db = getTestDb();
    const id = uuidv7();

    await db.insert(authUser).values({ id, email: 'test@example.com' });
    const rows = await db.select().from(authUser).where(eq(authUser.id, id));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.email).toBe('test@example.com');
    expect(rows[0]?.emailVerified).toBe(false);
    expect(rows[0]?.createdAt).toBeInstanceOf(Date);
  });

  it('rejects duplicate email (unique constraint)', async () => {
    const db = getTestDb();

    await db.insert(authUser).values({ id: uuidv7(), email: 'dupe@example.com' });

    await expect(
      db.insert(authUser).values({ id: uuidv7(), email: 'dupe@example.com' }),
    ).rejects.toThrow();
  });
});

describe('auth_session', () => {
  beforeEach(resetDb);

  it('inserts and reads back a session with FK to user', async () => {
    const db = getTestDb();
    const userId = uuidv7();
    const sessionId = uuidv7();

    await db.insert(authUser).values({ id: userId, email: 'session-test@example.com' });
    await db.insert(authSession).values({
      id: sessionId,
      userId,
      token: `session-${sessionId}`,
      expiresAt: oneHourFromNow(),
    });

    const rows = await db.select().from(authSession).where(eq(authSession.id, sessionId));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(userId);
    expect(rows[0]?.expiresAt).toBeInstanceOf(Date);
  });

  it('cascades delete: removing a user removes their sessions', async () => {
    const db = getTestDb();
    const userId = uuidv7();

    await db.insert(authUser).values({ id: userId, email: 'cascade-test@example.com' });
    await db.insert(authSession).values({
      id: uuidv7(),
      userId,
      token: 'cascade-token',
      expiresAt: oneHourFromNow(),
    });

    await db.delete(authUser).where(eq(authUser.id, userId));

    const remaining = await db.select().from(authSession).where(eq(authSession.userId, userId));
    expect(remaining).toHaveLength(0);
  });
});

describe('auth_account', () => {
  beforeEach(resetDb);

  it('inserts and reads back an OAuth account linkage', async () => {
    const db = getTestDb();
    const userId = uuidv7();
    const accountRowId = uuidv7();

    await db.insert(authUser).values({ id: userId, email: 'oauth@example.com' });
    await db.insert(authAccount).values({
      id: accountRowId,
      userId,
      providerId: 'google',
      accountId: 'google-user-12345',
    });

    const rows = await db.select().from(authAccount).where(eq(authAccount.id, accountRowId));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.providerId).toBe('google');
    expect(rows[0]?.accountId).toBe('google-user-12345');
  });

  it('rejects duplicate (provider_id, account_id) — composite unique', async () => {
    const db = getTestDb();
    const userId = uuidv7();

    await db.insert(authUser).values({ id: userId, email: 'dupe-oauth@example.com' });
    await db.insert(authAccount).values({
      id: uuidv7(),
      userId,
      providerId: 'google',
      accountId: 'same-google-id',
    });

    await expect(
      db.insert(authAccount).values({
        id: uuidv7(),
        userId,
        providerId: 'google',
        accountId: 'same-google-id',
      }),
    ).rejects.toThrow();
  });

  it('cascades delete: removing a user removes their account linkages', async () => {
    const db = getTestDb();
    const userId = uuidv7();

    await db.insert(authUser).values({ id: userId, email: 'oauth-cascade@example.com' });
    await db.insert(authAccount).values({
      id: uuidv7(),
      userId,
      providerId: 'github',
      accountId: 'gh-user-99',
    });

    await db.delete(authUser).where(eq(authUser.id, userId));

    const remaining = await db.select().from(authAccount).where(eq(authAccount.userId, userId));
    expect(remaining).toHaveLength(0);
  });
});

describe('auth_verification', () => {
  beforeEach(resetDb);

  it('inserts and reads back a verification token', async () => {
    const db = getTestDb();
    const id = uuidv7();

    await db.insert(authVerification).values({
      id,
      identifier: 'verify@example.com',
      value: 'token-abc-123',
      expiresAt: oneHourFromNow(),
    });

    const rows = await db.select().from(authVerification).where(eq(authVerification.id, id));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.identifier).toBe('verify@example.com');
    expect(rows[0]?.value).toBe('token-abc-123');
  });
});

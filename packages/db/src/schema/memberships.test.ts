import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, resetDb } from '../../tests/db-test-helper.js';
import { accounts } from './accounts.js';
import { authUser } from './auth.js';
import { memberships } from './memberships.js';

describe('memberships', () => {
  beforeEach(resetDb);

  it('inserts and reads back a membership joining user + account', async () => {
    const db = getTestDb();
    const userId = uuidv7();
    const accountId = uuidv7();
    const membershipId = uuidv7();

    await db.insert(authUser).values({ id: userId, email: 'member@example.com' });
    await db.insert(accounts).values({ id: accountId, name: 'Shared Workspace' });
    await db.insert(memberships).values({ id: membershipId, userId, accountId });

    const rows = await db.select().from(memberships).where(eq(memberships.id, membershipId));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(userId);
    expect(rows[0]?.accountId).toBe(accountId);
  });

  it('rejects insert with non-existent user_id (FK constraint)', async () => {
    const db = getTestDb();
    const accountId = uuidv7();

    await db.insert(accounts).values({ id: accountId, name: 'Lonely Account' });

    await expect(
      db.insert(memberships).values({
        id: uuidv7(),
        userId: uuidv7(),
        accountId,
      }),
    ).rejects.toThrow();
  });

  it('rejects insert with non-existent account_id (FK constraint)', async () => {
    const db = getTestDb();
    const userId = uuidv7();

    await db.insert(authUser).values({ id: userId, email: 'orphan-attempt@example.com' });

    await expect(
      db.insert(memberships).values({
        id: uuidv7(),
        userId,
        accountId: uuidv7(),
      }),
    ).rejects.toThrow();
  });

  it('rejects duplicate (user_id, account_id) — composite unique', async () => {
    const db = getTestDb();
    const userId = uuidv7();
    const accountId = uuidv7();

    await db.insert(authUser).values({ id: userId, email: 'double-member@example.com' });
    await db.insert(accounts).values({ id: accountId, name: 'Double Membership' });
    await db.insert(memberships).values({ id: uuidv7(), userId, accountId });

    await expect(
      db.insert(memberships).values({
        id: uuidv7(),
        userId,
        accountId,
      }),
    ).rejects.toThrow();
  });

  it('cascades delete: removing a user removes their memberships', async () => {
    const db = getTestDb();
    const userId = uuidv7();
    const accountId = uuidv7();

    await db.insert(authUser).values({ id: userId, email: 'cascade-user@example.com' });
    await db.insert(accounts).values({ id: accountId, name: 'User Cascade' });
    await db.insert(memberships).values({ id: uuidv7(), userId, accountId });

    await db.delete(authUser).where(eq(authUser.id, userId));

    const remaining = await db.select().from(memberships).where(eq(memberships.userId, userId));
    expect(remaining).toHaveLength(0);
  });

  it('cascades delete: removing an account removes its memberships', async () => {
    const db = getTestDb();
    const userId = uuidv7();
    const accountId = uuidv7();

    await db.insert(authUser).values({ id: userId, email: 'cascade-account@example.com' });
    await db.insert(accounts).values({ id: accountId, name: 'Account Cascade' });
    await db.insert(memberships).values({ id: uuidv7(), userId, accountId });

    await db.delete(accounts).where(eq(accounts.id, accountId));

    const remaining = await db
      .select()
      .from(memberships)
      .where(eq(memberships.accountId, accountId));
    expect(remaining).toHaveLength(0);
  });

  it('allows one user to belong to multiple accounts', async () => {
    const db = getTestDb();
    const userId = uuidv7();
    const accountAId = uuidv7();
    const accountBId = uuidv7();

    await db.insert(authUser).values({ id: userId, email: 'bookkeeper@example.com' });
    await db.insert(accounts).values([
      { id: accountAId, name: 'Client A' },
      { id: accountBId, name: 'Client B' },
    ]);
    await db.insert(memberships).values([
      { id: uuidv7(), userId, accountId: accountAId },
      { id: uuidv7(), userId, accountId: accountBId },
    ]);

    const rows = await db.select().from(memberships).where(eq(memberships.userId, userId));

    expect(rows).toHaveLength(2);
    const accountIds = rows.map((r) => r.accountId).sort();
    expect(accountIds).toEqual([accountAId, accountBId].sort());
  });
});

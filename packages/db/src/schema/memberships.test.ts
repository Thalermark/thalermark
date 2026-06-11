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

  it('defaults role to member when unspecified', async () => {
    const db = getTestDb();
    const userId = uuidv7();
    const accountId = uuidv7();

    await db.insert(authUser).values({ id: userId, email: 'default-role@example.com' });
    await db.insert(accounts).values({ id: accountId, name: 'Default Role' });
    await db.insert(memberships).values({ id: uuidv7(), userId, accountId });

    const [row] = await db.select().from(memberships).where(eq(memberships.userId, userId));
    expect(row?.role).toBe('member');
  });

  it('accepts each of the five roles', async () => {
    const db = getTestDb();
    const accountId = uuidv7();
    await db.insert(accounts).values({ id: accountId, name: 'All Roles' });

    // owner is capped at one per account by the partial unique index, so put it
    // in its own account; the other four share this one.
    const ownerAccountId = uuidv7();
    await db.insert(accounts).values({ id: ownerAccountId, name: 'Owner Role' });
    const ownerUserId = uuidv7();
    await db.insert(authUser).values({ id: ownerUserId, email: 'owner-role@example.com' });
    await db
      .insert(memberships)
      .values({ id: uuidv7(), userId: ownerUserId, accountId: ownerAccountId, role: 'owner' });

    for (const role of ['admin', 'member', 'accountant', 'viewer'] as const) {
      const userId = uuidv7();
      await db.insert(authUser).values({ id: userId, email: `${role}@example.com` });
      await db.insert(memberships).values({ id: uuidv7(), userId, accountId, role });
      const [row] = await db.select().from(memberships).where(eq(memberships.userId, userId));
      expect(row?.role).toBe(role);
    }
  });

  it('rejects an unknown role (CHECK constraint)', async () => {
    const db = getTestDb();
    const userId = uuidv7();
    const accountId = uuidv7();

    await db.insert(authUser).values({ id: userId, email: 'bad-role@example.com' });
    await db.insert(accounts).values({ id: accountId, name: 'Bad Role' });

    await expect(
      // role is free text at the type level; the CHECK constraint is the runtime
      // guard that rejects anything outside
      // ('owner','admin','member','accountant','viewer').
      db
        .insert(memberships)
        .values({ id: uuidv7(), userId, accountId, role: 'superuser' }),
    ).rejects.toThrow();
  });

  it('rejects a second owner in the same account (one-owner partial index)', async () => {
    const db = getTestDb();
    const accountId = uuidv7();
    const ownerA = uuidv7();
    const ownerB = uuidv7();

    await db.insert(authUser).values([
      { id: ownerA, email: 'owner-a@example.com' },
      { id: ownerB, email: 'owner-b@example.com' },
    ]);
    await db.insert(accounts).values({ id: accountId, name: 'Two Owners' });
    await db.insert(memberships).values({ id: uuidv7(), userId: ownerA, accountId, role: 'owner' });

    await expect(
      db.insert(memberships).values({ id: uuidv7(), userId: ownerB, accountId, role: 'owner' }),
    ).rejects.toThrow();
  });

  it('allows an owner in each of two different accounts', async () => {
    const db = getTestDb();
    const userId = uuidv7();
    const accountAId = uuidv7();
    const accountBId = uuidv7();

    await db.insert(authUser).values({ id: userId, email: 'multi-owner@example.com' });
    await db.insert(accounts).values([
      { id: accountAId, name: 'Owned A' },
      { id: accountBId, name: 'Owned B' },
    ]);
    await db.insert(memberships).values([
      { id: uuidv7(), userId, accountId: accountAId, role: 'owner' },
      { id: uuidv7(), userId, accountId: accountBId, role: 'owner' },
    ]);

    const rows = await db.select().from(memberships).where(eq(memberships.userId, userId));
    expect(rows.filter((r) => r.role === 'owner')).toHaveLength(2);
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

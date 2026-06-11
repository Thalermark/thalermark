import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, resetDb } from '../../tests/db-test-helper.js';
import { accounts } from './accounts.js';
import { authUser } from './auth.js';
import { invitations } from './invitations.js';

const HOUR = 60 * 60 * 1000;

describe('invitations', () => {
  beforeEach(resetDb);

  it('inserts and reads back an invitation', async () => {
    const db = getTestDb();
    const accountId = uuidv7();
    const inviterId = uuidv7();
    const id = uuidv7();

    await db.insert(accounts).values({ id: accountId, name: 'Acme' });
    await db.insert(authUser).values({ id: inviterId, email: 'inviter@example.com' });
    await db.insert(invitations).values({
      id,
      accountId,
      email: 'invitee@example.com',
      token: 'tok-aaa',
      invitedByUserId: inviterId,
      expiresAt: new Date(Date.now() + 7 * 24 * HOUR),
    });

    const [row] = await db.select().from(invitations).where(eq(invitations.id, id));
    expect(row?.email).toBe('invitee@example.com');
    expect(row?.acceptedAt).toBeNull();
    expect(row?.acceptedByUserId).toBeNull();
  });

  it('rejects duplicate tokens (unique constraint)', async () => {
    const db = getTestDb();
    const accountId = uuidv7();
    const inviterId = uuidv7();

    await db.insert(accounts).values({ id: accountId, name: 'Acme' });
    await db.insert(authUser).values({ id: inviterId, email: 'inviter@example.com' });
    await db.insert(invitations).values({
      id: uuidv7(),
      accountId,
      email: 'a@example.com',
      token: 'tok-shared',
      invitedByUserId: inviterId,
      expiresAt: new Date(Date.now() + HOUR),
    });

    await expect(
      db.insert(invitations).values({
        id: uuidv7(),
        accountId,
        email: 'b@example.com',
        token: 'tok-shared',
        invitedByUserId: inviterId,
        expiresAt: new Date(Date.now() + HOUR),
      }),
    ).rejects.toThrow();
  });

  it('defaults role to member and accepts the four invitable roles', async () => {
    const db = getTestDb();
    const accountId = uuidv7();
    const inviterId = uuidv7();

    await db.insert(accounts).values({ id: accountId, name: 'Acme' });
    await db.insert(authUser).values({ id: inviterId, email: 'inviter@example.com' });

    const defaultId = uuidv7();
    await db.insert(invitations).values({
      id: defaultId,
      accountId,
      email: 'default@example.com',
      token: 'tok-default',
      invitedByUserId: inviterId,
      expiresAt: new Date(Date.now() + HOUR),
    });
    const [row] = await db.select().from(invitations).where(eq(invitations.id, defaultId));
    expect(row?.role).toBe('member');

    for (const role of ['admin', 'member', 'accountant', 'viewer'] as const) {
      await db.insert(invitations).values({
        id: uuidv7(),
        accountId,
        email: `${role}@example.com`,
        role,
        token: `tok-${role}`,
        invitedByUserId: inviterId,
        expiresAt: new Date(Date.now() + HOUR),
      });
    }
  });

  it('rejects owner and unknown roles (CHECK constraint)', async () => {
    const db = getTestDb();
    const accountId = uuidv7();
    const inviterId = uuidv7();

    await db.insert(accounts).values({ id: accountId, name: 'Acme' });
    await db.insert(authUser).values({ id: inviterId, email: 'inviter@example.com' });

    for (const role of ['owner', 'superuser']) {
      await expect(
        db.insert(invitations).values({
          id: uuidv7(),
          accountId,
          email: 'bad@example.com',
          role,
          token: `tok-${role}`,
          invitedByUserId: inviterId,
          expiresAt: new Date(Date.now() + HOUR),
        }),
      ).rejects.toThrow();
    }
  });

  it('cascades delete from accounts → invitations', async () => {
    const db = getTestDb();
    const accountId = uuidv7();
    const inviterId = uuidv7();
    const invitationId = uuidv7();

    await db.insert(accounts).values({ id: accountId, name: 'Acme' });
    await db.insert(authUser).values({ id: inviterId, email: 'inviter@example.com' });
    await db.insert(invitations).values({
      id: invitationId,
      accountId,
      email: 'invitee@example.com',
      token: 'tok-cascade',
      invitedByUserId: inviterId,
      expiresAt: new Date(Date.now() + HOUR),
    });

    await db.delete(accounts).where(eq(accounts.id, accountId));
    const remaining = await db.select().from(invitations).where(eq(invitations.id, invitationId));
    expect(remaining).toEqual([]);
  });
});

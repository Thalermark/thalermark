import { eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, describe, expect, it } from 'vitest';
import { getAppDb, getStaffDb, getTestDb, resetDb } from '../tests/db-test-helper.js';
import { withAccountContext } from './client.js';
import { accounts } from './schema/accounts.js';
import { auditEvents } from './schema/audit_events.js';
import { authUser } from './schema/auth.js';
import { companies } from './schema/companies.js';
import { memberships } from './schema/memberships.js';

// Slice 1.5 — full isolation matrix. Tests connect AS thalermark_app and
// thalermark_staff_readonly (not the testcontainer superuser) so RLS is
// actually enforced. Seeding still goes through the superuser connection.

// Two seeded tenants used across the suite.
let accountAId: string;
let accountBId: string;
let userId: string;
let userInBothId: string;

async function seedTwoTenants() {
  const db = getTestDb();
  accountAId = uuidv7();
  accountBId = uuidv7();
  userId = uuidv7();
  userInBothId = uuidv7();

  await db.insert(accounts).values([
    { id: accountAId, name: 'Account A' },
    { id: accountBId, name: 'Account B' },
  ]);
  await db.insert(authUser).values([
    { id: userId, email: 'a-only@example.com' },
    { id: userInBothId, email: 'a-and-b@example.com' },
  ]);
  await db.insert(companies).values([
    { id: uuidv7(), accountId: accountAId, name: 'A Co' },
    { id: uuidv7(), accountId: accountBId, name: 'B Co' },
  ]);
  await db.insert(memberships).values([
    { id: uuidv7(), userId, accountId: accountAId },
    { id: uuidv7(), userId: userInBothId, accountId: accountAId },
    { id: uuidv7(), userId: userInBothId, accountId: accountBId },
  ]);
}

describe('RLS — app role tenant isolation (SELECT)', () => {
  beforeEach(async () => {
    await resetDb();
    await seedTwoTenants();
  });

  it('sees only its own account when account context is set', async () => {
    const seen = await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      return tx.select().from(accounts);
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.id).toBe(accountAId);
  });

  it('sees only its own account companies', async () => {
    const seen = await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      return tx.select().from(companies);
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.accountId).toBe(accountAId);
  });

  it('sees no rows when no account context is set', async () => {
    // No withAccountContext wrapper — query directly as the app role.
    const seenAccounts = await getAppDb().select().from(accounts);
    const seenCompanies = await getAppDb().select().from(companies);
    expect(seenAccounts).toEqual([]);
    expect(seenCompanies).toEqual([]);
  });

  it('cannot see account B rows even when explicitly filtering for B', async () => {
    const seen = await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      return tx.select().from(accounts).where(eq(accounts.id, accountBId));
    });
    expect(seen).toEqual([]);
  });
});

describe('RLS — app role tenant isolation (WITH CHECK on INSERT)', () => {
  beforeEach(async () => {
    await resetDb();
    await seedTwoTenants();
  });

  it('allows insert with matching account_id', async () => {
    await expect(
      withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
        await tx.insert(companies).values({
          id: uuidv7(),
          accountId: accountAId,
          name: 'A Co #2',
        });
      }),
    ).resolves.not.toThrow();
  });

  it('blocks insert with a foreign account_id (WITH CHECK violation)', async () => {
    const smuggledId = uuidv7();
    await expect(
      withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
        await tx.insert(companies).values({
          id: smuggledId,
          accountId: accountBId,
          name: 'Smuggled B Co',
        });
      }),
    ).rejects.toThrow();
    // Confirm via superuser that no smuggled row was created.
    const found = await getTestDb().select().from(companies).where(eq(companies.id, smuggledId));
    expect(found).toEqual([]);
  });
});

describe('RLS — app role tenant isolation (UPDATE / DELETE)', () => {
  beforeEach(async () => {
    await resetDb();
    await seedTwoTenants();
  });

  it('cannot UPDATE rows belonging to another account', async () => {
    await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      await tx.update(companies).set({ name: 'pwned' }).where(eq(companies.accountId, accountBId));
    });
    // Confirm via superuser that B's company is untouched.
    const bRows = await getTestDb()
      .select()
      .from(companies)
      .where(eq(companies.accountId, accountBId));
    expect(bRows[0]?.name).toBe('B Co');
  });

  it('cannot DELETE rows belonging to another account', async () => {
    await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      await tx.delete(companies).where(eq(companies.accountId, accountBId));
    });
    const bRows = await getTestDb()
      .select()
      .from(companies)
      .where(eq(companies.accountId, accountBId));
    expect(bRows).toHaveLength(1);
  });
});

describe('RLS — memberships user-scoped SELECT (auth-bootstrap flow)', () => {
  beforeEach(async () => {
    await resetDb();
    await seedTwoTenants();
  });

  it("with only user_id set, returns the user's memberships across accounts", async () => {
    // No accountId in the GUC — only userId. Drizzle's transaction wrapper
    // still requires us to use set_config directly.
    const db = getAppDb();
    const seen = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_user_id', ${userInBothId}, true)`);
      return tx.select().from(memberships);
    });
    expect(seen).toHaveLength(2);
    const accountIds = seen.map((r) => r.accountId).sort();
    expect(accountIds).toEqual([accountAId, accountBId].sort());
  });

  it('with neither GUC set, sees no memberships', async () => {
    const seen = await getAppDb().select().from(memberships);
    expect(seen).toEqual([]);
  });

  it("with account_id set, sees that account's memberships regardless of user", async () => {
    const seen = await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      return tx.select().from(memberships);
    });
    expect(seen).toHaveLength(2);
    for (const row of seen) {
      expect(row.accountId).toBe(accountAId);
    }
  });
});

describe('RLS — staff_readonly role', () => {
  beforeEach(async () => {
    await resetDb();
    await seedTwoTenants();
  });

  it('reads all accounts regardless of GUC (BYPASSRLS)', async () => {
    const seen = await getStaffDb().select().from(accounts);
    expect(seen.map((a) => a.id).sort()).toEqual([accountAId, accountBId].sort());
  });

  it('reads all companies regardless of GUC', async () => {
    const seen = await getStaffDb().select().from(companies);
    expect(seen).toHaveLength(2);
  });

  it('cannot INSERT (privilege denied)', async () => {
    const smuggledId = uuidv7();
    await expect(
      getStaffDb().insert(accounts).values({ id: smuggledId, name: 'Staff Wuz Here' }),
    ).rejects.toThrow();
    const found = await getTestDb().select().from(accounts).where(eq(accounts.id, smuggledId));
    expect(found).toEqual([]);
  });

  it('cannot UPDATE (privilege denied)', async () => {
    await expect(
      getStaffDb().update(accounts).set({ name: 'pwned' }).where(eq(accounts.id, accountAId)),
    ).rejects.toThrow();
    const row = await getTestDb().select().from(accounts).where(eq(accounts.id, accountAId));
    expect(row[0]?.name).toBe('Account A');
  });

  it('cannot DELETE (privilege denied)', async () => {
    await expect(
      getStaffDb().delete(accounts).where(eq(accounts.id, accountAId)),
    ).rejects.toThrow();
    const row = await getTestDb().select().from(accounts).where(eq(accounts.id, accountAId));
    expect(row).toHaveLength(1);
  });
});

// audit_events sits on top of the same account-isolation idiom as the other
// tenant tables, with the added twist that UPDATE and DELETE have no policy
// at all — so they silently affect zero rows under the app role (Postgres
// "RLS hides the row from the operation"), giving us append-only semantics.

async function seedAuditEvents() {
  const db = getTestDb();
  await db.insert(auditEvents).values([
    {
      id: uuidv7(),
      accountId: accountAId,
      actorUserId: userId,
      entityType: 'invoice',
      entityId: uuidv7(),
      action: 'create',
      after: { number: 'A-1' },
    },
    {
      id: uuidv7(),
      accountId: accountBId,
      actorUserId: userInBothId,
      entityType: 'invoice',
      entityId: uuidv7(),
      action: 'create',
      after: { number: 'B-1' },
    },
  ]);
}

describe('RLS — audit_events account isolation', () => {
  beforeEach(async () => {
    await resetDb();
    await seedTwoTenants();
    await seedAuditEvents();
  });

  it('sees only its own account events when context is set', async () => {
    const seen = await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      return tx.select().from(auditEvents);
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.accountId).toBe(accountAId);
  });

  it('sees no rows when no account context is set', async () => {
    const seen = await getAppDb().select().from(auditEvents);
    expect(seen).toEqual([]);
  });

  it('allows insert with matching account_id', async () => {
    const id = uuidv7();
    await expect(
      withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
        await tx.insert(auditEvents).values({
          id,
          accountId: accountAId,
          actorUserId: userId,
          entityType: 'invoice',
          entityId: uuidv7(),
          action: 'update',
          before: { status: 'draft' },
          after: { status: 'sent' },
        });
      }),
    ).resolves.not.toThrow();
    const found = await getTestDb().select().from(auditEvents).where(eq(auditEvents.id, id));
    expect(found).toHaveLength(1);
  });

  it('blocks insert with a foreign account_id (WITH CHECK violation)', async () => {
    const smuggledId = uuidv7();
    await expect(
      withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
        await tx.insert(auditEvents).values({
          id: smuggledId,
          accountId: accountBId,
          actorUserId: userId,
          entityType: 'invoice',
          entityId: uuidv7(),
          action: 'create',
        });
      }),
    ).rejects.toThrow();
    const found = await getTestDb()
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.id, smuggledId));
    expect(found).toEqual([]);
  });
});

describe('RLS — audit_events is append-only (no UPDATE / DELETE policy)', () => {
  beforeEach(async () => {
    await resetDb();
    await seedTwoTenants();
    await seedAuditEvents();
  });

  it('cannot UPDATE an event in its own account (no policy = invisible to UPDATE)', async () => {
    await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      await tx
        .update(auditEvents)
        .set({ action: 'tampered' })
        .where(eq(auditEvents.accountId, accountAId));
    });
    const rows = await getTestDb()
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.accountId, accountAId));
    expect(rows[0]?.action).toBe('create');
  });

  it('cannot DELETE an event in its own account', async () => {
    await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      await tx.delete(auditEvents).where(eq(auditEvents.accountId, accountAId));
    });
    const rows = await getTestDb()
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.accountId, accountAId));
    expect(rows).toHaveLength(1);
  });

  it('cannot UPDATE events in another account', async () => {
    await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      await tx
        .update(auditEvents)
        .set({ action: 'tampered' })
        .where(eq(auditEvents.accountId, accountBId));
    });
    const rows = await getTestDb()
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.accountId, accountBId));
    expect(rows[0]?.action).toBe('create');
  });

  it('cannot DELETE events in another account', async () => {
    await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      await tx.delete(auditEvents).where(eq(auditEvents.accountId, accountBId));
    });
    const rows = await getTestDb()
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.accountId, accountBId));
    expect(rows).toHaveLength(1);
  });
});

describe('RLS — audit_events under staff_readonly', () => {
  beforeEach(async () => {
    await resetDb();
    await seedTwoTenants();
    await seedAuditEvents();
  });

  it('reads audit events across accounts (BYPASSRLS)', async () => {
    const seen = await getStaffDb().select().from(auditEvents);
    expect(seen).toHaveLength(2);
  });

  it('cannot INSERT (privilege denied)', async () => {
    await expect(
      getStaffDb().insert(auditEvents).values({
        id: uuidv7(),
        accountId: accountAId,
        actorUserId: userId,
        entityType: 'invoice',
        entityId: uuidv7(),
        action: 'create',
      }),
    ).rejects.toThrow();
  });
});

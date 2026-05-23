import { eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, describe, expect, it } from 'vitest';
import { getAppDb, getStaffDb, getTestDb, resetDb } from '../tests/db-test-helper.js';
import { withAccountContext } from './client.js';
import { accounts } from './schema/accounts.js';
import { auditEvents } from './schema/audit_events.js';
import { authUser } from './schema/auth.js';
import { companies } from './schema/companies.js';
import { customers } from './schema/customers.js';
import { invitations } from './schema/invitations.js';
import { memberships } from './schema/memberships.js';
import { telemetryEvents } from './schema/telemetry_events.js';

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

// telemetry_events uses the same NULLIF tenant idiom but, unlike audit_events,
// is *not* append-only. The HTTP transport needs DELETE within tenant scope to
// drain successfully-sent rows (Slice 2.4); the opt-out path needs DELETE to
// purge an account's queue (Slice 2.3). Staff readonly still cannot mutate.

async function seedTelemetryEvents() {
  const db = getTestDb();
  await db.insert(telemetryEvents).values([
    {
      id: uuidv7(),
      accountId: accountAId,
      eventName: 'invoice_created',
      payload: { line_item_count: 3 },
    },
    {
      id: uuidv7(),
      accountId: accountBId,
      eventName: 'invoice_created',
      payload: { line_item_count: 5 },
    },
  ]);
}

describe('RLS — telemetry_events account isolation', () => {
  beforeEach(async () => {
    await resetDb();
    await seedTwoTenants();
    await seedTelemetryEvents();
  });

  it('sees only its own account events when context is set', async () => {
    const seen = await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      return tx.select().from(telemetryEvents);
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.accountId).toBe(accountAId);
  });

  it('sees no rows when no account context is set', async () => {
    const seen = await getAppDb().select().from(telemetryEvents);
    expect(seen).toEqual([]);
  });

  it('allows insert with matching account_id', async () => {
    const id = uuidv7();
    await expect(
      withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
        await tx.insert(telemetryEvents).values({
          id,
          accountId: accountAId,
          eventName: 'session_start',
          payload: { deployment_type: 'cloud', product_version: '0.1.0' },
        });
      }),
    ).resolves.not.toThrow();
    const found = await getTestDb()
      .select()
      .from(telemetryEvents)
      .where(eq(telemetryEvents.id, id));
    expect(found).toHaveLength(1);
  });

  it('blocks insert with a foreign account_id (WITH CHECK violation)', async () => {
    const smuggledId = uuidv7();
    await expect(
      withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
        await tx.insert(telemetryEvents).values({
          id: smuggledId,
          accountId: accountBId,
          eventName: 'invoice_created',
          payload: { line_item_count: 1 },
        });
      }),
    ).rejects.toThrow();
    const found = await getTestDb()
      .select()
      .from(telemetryEvents)
      .where(eq(telemetryEvents.id, smuggledId));
    expect(found).toEqual([]);
  });
});

describe('RLS — telemetry_events allows tenant-scoped DELETE (staging table)', () => {
  beforeEach(async () => {
    await resetDb();
    await seedTwoTenants();
    await seedTelemetryEvents();
  });

  it('deletes its own account events (drain after HTTP send)', async () => {
    await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      await tx.delete(telemetryEvents);
    });
    const aRows = await getTestDb()
      .select()
      .from(telemetryEvents)
      .where(eq(telemetryEvents.accountId, accountAId));
    expect(aRows).toEqual([]);
  });

  it('cannot DELETE rows in another account (silent no-op)', async () => {
    await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      await tx.delete(telemetryEvents).where(eq(telemetryEvents.accountId, accountBId));
    });
    const bRows = await getTestDb()
      .select()
      .from(telemetryEvents)
      .where(eq(telemetryEvents.accountId, accountBId));
    expect(bRows).toHaveLength(1);
  });
});

describe('RLS — telemetry_events under staff_readonly', () => {
  beforeEach(async () => {
    await resetDb();
    await seedTwoTenants();
    await seedTelemetryEvents();
  });

  it('reads telemetry events across accounts (BYPASSRLS)', async () => {
    const seen = await getStaffDb().select().from(telemetryEvents);
    expect(seen).toHaveLength(2);
  });

  it('cannot INSERT (privilege denied)', async () => {
    await expect(
      getStaffDb()
        .insert(telemetryEvents)
        .values({
          id: uuidv7(),
          accountId: accountAId,
          eventName: 'invoice_created',
          payload: { line_item_count: 1 },
        }),
    ).rejects.toThrow();
  });

  it('cannot DELETE (privilege denied)', async () => {
    await expect(getStaffDb().delete(telemetryEvents)).rejects.toThrow();
    const rows = await getTestDb().select().from(telemetryEvents);
    expect(rows).toHaveLength(2);
  });
});

const HOUR = 60 * 60 * 1000;

async function seedInvitations() {
  const db = getTestDb();
  await db.insert(invitations).values([
    {
      id: uuidv7(),
      accountId: accountAId,
      email: 'pending-a@example.com',
      token: 'tok-a',
      invitedByUserId: userId,
      expiresAt: new Date(Date.now() + 7 * 24 * HOUR),
    },
    {
      id: uuidv7(),
      accountId: accountBId,
      email: 'pending-b@example.com',
      token: 'tok-b',
      invitedByUserId: userInBothId,
      expiresAt: new Date(Date.now() + 7 * 24 * HOUR),
    },
  ]);
}

describe('RLS — invitations account isolation', () => {
  beforeEach(async () => {
    await resetDb();
    await seedTwoTenants();
    await seedInvitations();
  });

  it('sees only its own account invitations when context is set', async () => {
    const seen = await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      return tx.select().from(invitations);
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.accountId).toBe(accountAId);
  });

  it('sees no rows when no account context is set', async () => {
    const seen = await getAppDb().select().from(invitations);
    expect(seen).toEqual([]);
  });

  it('allows insert with matching account_id', async () => {
    const id = uuidv7();
    await expect(
      withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
        await tx.insert(invitations).values({
          id,
          accountId: accountAId,
          email: 'new-a@example.com',
          token: 'tok-new-a',
          invitedByUserId: userId,
          expiresAt: new Date(Date.now() + HOUR),
        });
      }),
    ).resolves.not.toThrow();
    const found = await getTestDb().select().from(invitations).where(eq(invitations.id, id));
    expect(found).toHaveLength(1);
  });

  it('blocks insert with a foreign account_id (WITH CHECK violation)', async () => {
    const smuggledId = uuidv7();
    await expect(
      withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
        await tx.insert(invitations).values({
          id: smuggledId,
          accountId: accountBId,
          email: 'smuggled@example.com',
          token: 'tok-smuggled',
          invitedByUserId: userId,
          expiresAt: new Date(Date.now() + HOUR),
        });
      }),
    ).rejects.toThrow();
    const found = await getTestDb()
      .select()
      .from(invitations)
      .where(eq(invitations.id, smuggledId));
    expect(found).toEqual([]);
  });

  it('cannot UPDATE invitations in another account', async () => {
    await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      await tx
        .update(invitations)
        .set({ email: 'hijacked@example.com' })
        .where(eq(invitations.accountId, accountBId));
    });
    const bRows = await getTestDb()
      .select()
      .from(invitations)
      .where(eq(invitations.accountId, accountBId));
    expect(bRows[0]?.email).toBe('pending-b@example.com');
  });
});

describe('RLS — invitations under staff_readonly', () => {
  beforeEach(async () => {
    await resetDb();
    await seedTwoTenants();
    await seedInvitations();
  });

  it('reads invitations across accounts (BYPASSRLS)', async () => {
    const seen = await getStaffDb().select().from(invitations);
    expect(seen).toHaveLength(2);
  });

  it('cannot INSERT (privilege denied)', async () => {
    await expect(
      getStaffDb()
        .insert(invitations)
        .values({
          id: uuidv7(),
          accountId: accountAId,
          email: 'staff-wuz-here@example.com',
          token: 'tok-staff',
          invitedByUserId: userId,
          expiresAt: new Date(Date.now() + HOUR),
        }),
    ).rejects.toThrow();
  });
});

// customers carry both account_id (RLS key) and company_id (FK only). Same
// tenant idiom as the other domain tables; the app role gets full CRUD within
// its account scope (unlike audit_events) because customers are user-mutable.

async function seedCustomers(): Promise<{ companyAId: string; companyBId: string }> {
  const db = getTestDb();
  const [companyA] = await db.select().from(companies).where(eq(companies.accountId, accountAId));
  const [companyB] = await db.select().from(companies).where(eq(companies.accountId, accountBId));
  if (!companyA || !companyB) throw new Error('seedTwoTenants did not produce one company each');

  await db.insert(customers).values([
    { id: uuidv7(), accountId: accountAId, companyId: companyA.id, name: 'A Customer' },
    { id: uuidv7(), accountId: accountBId, companyId: companyB.id, name: 'B Customer' },
  ]);

  return { companyAId: companyA.id, companyBId: companyB.id };
}

describe('RLS — customers account isolation', () => {
  let companyAId: string;
  let companyBId: string;

  beforeEach(async () => {
    await resetDb();
    await seedTwoTenants();
    ({ companyAId, companyBId } = await seedCustomers());
  });

  it('sees only its own account customers when context is set', async () => {
    const seen = await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      return tx.select().from(customers);
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.accountId).toBe(accountAId);
    expect(seen[0]?.name).toBe('A Customer');
  });

  it('sees no rows when no account context is set', async () => {
    const seen = await getAppDb().select().from(customers);
    expect(seen).toEqual([]);
  });

  it('allows insert with matching account_id', async () => {
    const id = uuidv7();
    await expect(
      withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
        await tx.insert(customers).values({
          id,
          accountId: accountAId,
          companyId: companyAId,
          name: 'A Customer #2',
        });
      }),
    ).resolves.not.toThrow();
    const found = await getTestDb().select().from(customers).where(eq(customers.id, id));
    expect(found).toHaveLength(1);
  });

  it('blocks insert with a foreign account_id (WITH CHECK violation)', async () => {
    const smuggledId = uuidv7();
    await expect(
      withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
        await tx.insert(customers).values({
          id: smuggledId,
          accountId: accountBId,
          companyId: companyBId,
          name: 'Smuggled B Customer',
        });
      }),
    ).rejects.toThrow();
    const found = await getTestDb().select().from(customers).where(eq(customers.id, smuggledId));
    expect(found).toEqual([]);
  });

  it('cannot UPDATE customers in another account', async () => {
    await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      await tx.update(customers).set({ name: 'pwned' }).where(eq(customers.accountId, accountBId));
    });
    const bRows = await getTestDb()
      .select()
      .from(customers)
      .where(eq(customers.accountId, accountBId));
    expect(bRows[0]?.name).toBe('B Customer');
  });

  it('cannot DELETE customers in another account', async () => {
    await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      await tx.delete(customers).where(eq(customers.accountId, accountBId));
    });
    const bRows = await getTestDb()
      .select()
      .from(customers)
      .where(eq(customers.accountId, accountBId));
    expect(bRows).toHaveLength(1);
  });

  it('allows tenant-scoped DELETE within own account', async () => {
    await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      await tx.delete(customers).where(eq(customers.accountId, accountAId));
    });
    const aRows = await getTestDb()
      .select()
      .from(customers)
      .where(eq(customers.accountId, accountAId));
    expect(aRows).toEqual([]);
  });
});

describe('RLS — customers under staff_readonly', () => {
  let companyAId: string;

  beforeEach(async () => {
    await resetDb();
    await seedTwoTenants();
    ({ companyAId } = await seedCustomers());
  });

  it('reads customers across accounts (BYPASSRLS)', async () => {
    const seen = await getStaffDb().select().from(customers);
    expect(seen).toHaveLength(2);
  });

  it('cannot INSERT (privilege denied)', async () => {
    await expect(
      getStaffDb().insert(customers).values({
        id: uuidv7(),
        accountId: accountAId,
        companyId: companyAId,
        name: 'Staff Wuz Here',
      }),
    ).rejects.toThrow();
  });

  it('cannot UPDATE (privilege denied)', async () => {
    await expect(
      getStaffDb()
        .update(customers)
        .set({ name: 'pwned' })
        .where(eq(customers.accountId, accountAId)),
    ).rejects.toThrow();
  });

  it('cannot DELETE (privilege denied)', async () => {
    await expect(getStaffDb().delete(customers)).rejects.toThrow();
    const rows = await getTestDb().select().from(customers);
    expect(rows).toHaveLength(2);
  });
});

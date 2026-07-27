import { eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, describe, expect, it } from 'vitest';
import { getAppDb, getStaffDb, getTestDb, resetDb } from '../tests/db-test-helper.js';
import { withAccountContext } from './client.js';
import { accounts } from './schema/accounts.js';
import { auditEvents } from './schema/audit_events.js';
import { authUser } from './schema/auth.js';
import { chartOfAccounts } from './schema/chart_of_accounts.js';
import { companies } from './schema/companies.js';
import { contacts } from './schema/contacts.js';
import { emailTemplates } from './schema/email_templates.js';
import { estimateLineItems, estimates } from './schema/estimates.js';
import { expenses } from './schema/expenses.js';
import { invitations } from './schema/invitations.js';
import { invoiceLineItems, invoices } from './schema/invoices.js';
import { items } from './schema/items.js';
import { memberships } from './schema/memberships.js';
import { recurringInvoiceLineItems, recurringInvoices } from './schema/recurring-invoices.js';
import { telemetryEvents } from './schema/telemetry_events.js';
import { seedChartOfAccounts } from './seed/coa.js';

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

// contacts carry both account_id (RLS key) and company_id (FK only). Same
// tenant idiom as the other domain tables; the app role gets full CRUD within
// its account scope (unlike audit_events) because contacts are user-mutable.

async function seedContacts(): Promise<{ companyAId: string; companyBId: string }> {
  const db = getTestDb();
  const [companyA] = await db.select().from(companies).where(eq(companies.accountId, accountAId));
  const [companyB] = await db.select().from(companies).where(eq(companies.accountId, accountBId));
  if (!companyA || !companyB) throw new Error('seedTwoTenants did not produce one company each');

  await db.insert(contacts).values([
    { id: uuidv7(), accountId: accountAId, companyId: companyA.id, name: 'A Contact' },
    { id: uuidv7(), accountId: accountBId, companyId: companyB.id, name: 'B Contact' },
  ]);

  return { companyAId: companyA.id, companyBId: companyB.id };
}

describe('RLS — contacts account isolation', () => {
  let companyAId: string;
  let companyBId: string;

  beforeEach(async () => {
    await resetDb();
    await seedTwoTenants();
    ({ companyAId, companyBId } = await seedContacts());
  });

  it('sees only its own account contacts when context is set', async () => {
    const seen = await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      return tx.select().from(contacts);
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.accountId).toBe(accountAId);
    expect(seen[0]?.name).toBe('A Contact');
  });

  it('sees no rows when no account context is set', async () => {
    const seen = await getAppDb().select().from(contacts);
    expect(seen).toEqual([]);
  });

  it('allows insert with matching account_id', async () => {
    const id = uuidv7();
    await expect(
      withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
        await tx.insert(contacts).values({
          id,
          accountId: accountAId,
          companyId: companyAId,
          name: 'A Contact #2',
        });
      }),
    ).resolves.not.toThrow();
    const found = await getTestDb().select().from(contacts).where(eq(contacts.id, id));
    expect(found).toHaveLength(1);
  });

  it('blocks insert with a foreign account_id (WITH CHECK violation)', async () => {
    const smuggledId = uuidv7();
    await expect(
      withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
        await tx.insert(contacts).values({
          id: smuggledId,
          accountId: accountBId,
          companyId: companyBId,
          name: 'Smuggled B Contact',
        });
      }),
    ).rejects.toThrow();
    const found = await getTestDb().select().from(contacts).where(eq(contacts.id, smuggledId));
    expect(found).toEqual([]);
  });

  it('cannot UPDATE contacts in another account', async () => {
    await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      await tx.update(contacts).set({ name: 'pwned' }).where(eq(contacts.accountId, accountBId));
    });
    const bRows = await getTestDb()
      .select()
      .from(contacts)
      .where(eq(contacts.accountId, accountBId));
    expect(bRows[0]?.name).toBe('B Contact');
  });

  it('cannot DELETE contacts in another account', async () => {
    await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      await tx.delete(contacts).where(eq(contacts.accountId, accountBId));
    });
    const bRows = await getTestDb()
      .select()
      .from(contacts)
      .where(eq(contacts.accountId, accountBId));
    expect(bRows).toHaveLength(1);
  });

  it('allows tenant-scoped DELETE within own account', async () => {
    await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      await tx.delete(contacts).where(eq(contacts.accountId, accountAId));
    });
    const aRows = await getTestDb()
      .select()
      .from(contacts)
      .where(eq(contacts.accountId, accountAId));
    expect(aRows).toEqual([]);
  });
});

describe('RLS — contacts under staff_readonly', () => {
  let companyAId: string;

  beforeEach(async () => {
    await resetDb();
    await seedTwoTenants();
    ({ companyAId } = await seedContacts());
  });

  it('reads contacts across accounts (BYPASSRLS)', async () => {
    const seen = await getStaffDb().select().from(contacts);
    expect(seen).toHaveLength(2);
  });

  it('cannot INSERT (privilege denied)', async () => {
    await expect(
      getStaffDb().insert(contacts).values({
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
        .update(contacts)
        .set({ name: 'pwned' })
        .where(eq(contacts.accountId, accountAId)),
    ).rejects.toThrow();
  });

  it('cannot DELETE (privilege denied)', async () => {
    await expect(getStaffDb().delete(contacts)).rejects.toThrow();
    const rows = await getTestDb().select().from(contacts);
    expect(rows).toHaveLength(2);
  });
});

// items: per-company catalog, same tenant idiom as contacts. App role gets
// full CRUD within its account (the archive/restore flow is UPDATE under the
// hood — there is no DELETE endpoint, but the RLS policy is the standard
// full-CRUD fence); staff_readonly bypasses RLS for SELECT only.

async function seedItems(): Promise<{ companyAId: string; companyBId: string }> {
  const db = getTestDb();
  const [companyA] = await db.select().from(companies).where(eq(companies.accountId, accountAId));
  const [companyB] = await db.select().from(companies).where(eq(companies.accountId, accountBId));
  if (!companyA || !companyB) throw new Error('seedTwoTenants did not produce one company each');

  await db.insert(items).values([
    { id: uuidv7(), accountId: accountAId, companyId: companyA.id, name: 'A Item' },
    { id: uuidv7(), accountId: accountBId, companyId: companyB.id, name: 'B Item' },
  ]);

  return { companyAId: companyA.id, companyBId: companyB.id };
}

describe('RLS — items account isolation', () => {
  let companyAId: string;
  let companyBId: string;

  beforeEach(async () => {
    await resetDb();
    await seedTwoTenants();
    ({ companyAId, companyBId } = await seedItems());
  });

  it('sees only its own account items when context is set', async () => {
    const seen = await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      return tx.select().from(items);
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.accountId).toBe(accountAId);
    expect(seen[0]?.name).toBe('A Item');
  });

  it('sees no rows when no account context is set', async () => {
    const seen = await getAppDb().select().from(items);
    expect(seen).toEqual([]);
  });

  it('allows insert with matching account_id', async () => {
    const id = uuidv7();
    await expect(
      withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
        await tx
          .insert(items)
          .values({ id, accountId: accountAId, companyId: companyAId, name: 'A Item #2' });
      }),
    ).resolves.not.toThrow();
    const found = await getTestDb().select().from(items).where(eq(items.id, id));
    expect(found).toHaveLength(1);
  });

  it('blocks insert with a foreign account_id (WITH CHECK violation)', async () => {
    const smuggledId = uuidv7();
    await expect(
      withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
        await tx.insert(items).values({
          id: smuggledId,
          accountId: accountBId,
          companyId: companyBId,
          name: 'Smuggled',
        });
      }),
    ).rejects.toThrow();
    const found = await getTestDb().select().from(items).where(eq(items.id, smuggledId));
    expect(found).toEqual([]);
  });

  it('cannot UPDATE items in another account', async () => {
    await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      await tx.update(items).set({ name: 'pwned' }).where(eq(items.accountId, accountBId));
    });
    const bRows = await getTestDb().select().from(items).where(eq(items.accountId, accountBId));
    expect(bRows[0]?.name).toBe('B Item');
  });

  it('cannot DELETE items in another account', async () => {
    await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      await tx.delete(items).where(eq(items.accountId, accountBId));
    });
    const bRows = await getTestDb().select().from(items).where(eq(items.accountId, accountBId));
    expect(bRows).toHaveLength(1);
  });
});

describe('RLS — items under staff_readonly', () => {
  let companyAId: string;

  beforeEach(async () => {
    await resetDb();
    await seedTwoTenants();
    ({ companyAId } = await seedItems());
  });

  it('reads items across accounts (BYPASSRLS)', async () => {
    const seen = await getStaffDb().select().from(items);
    expect(seen).toHaveLength(2);
  });

  it('cannot INSERT (privilege denied)', async () => {
    await expect(
      getStaffDb().insert(items).values({
        id: uuidv7(),
        accountId: accountAId,
        companyId: companyAId,
        name: 'Staff Wuz Here',
      }),
    ).rejects.toThrow();
  });

  it('cannot UPDATE (privilege denied)', async () => {
    await expect(
      getStaffDb().update(items).set({ name: 'pwned' }).where(eq(items.accountId, accountAId)),
    ).rejects.toThrow();
  });

  it('cannot DELETE (privilege denied)', async () => {
    await expect(getStaffDb().delete(items)).rejects.toThrow();
    const rows = await getTestDb().select().from(items);
    expect(rows).toHaveLength(2);
  });
});

// email_templates: per-company email overrides, same tenant idiom as items.
// App role gets full CRUD within its account (DELETE = reset-to-default);
// staff_readonly bypasses RLS for SELECT only.

async function seedEmailTemplates(): Promise<{ companyAId: string; companyBId: string }> {
  const db = getTestDb();
  const [companyA] = await db.select().from(companies).where(eq(companies.accountId, accountAId));
  const [companyB] = await db.select().from(companies).where(eq(companies.accountId, accountBId));
  if (!companyA || !companyB) throw new Error('seedTwoTenants did not produce one company each');

  await db.insert(emailTemplates).values([
    {
      id: uuidv7(),
      accountId: accountAId,
      companyId: companyA.id,
      type: 'invoice',
      subject: 'A',
      body: 'A body',
    },
    {
      id: uuidv7(),
      accountId: accountBId,
      companyId: companyB.id,
      type: 'invoice',
      subject: 'B',
      body: 'B body',
    },
  ]);

  return { companyAId: companyA.id, companyBId: companyB.id };
}

describe('RLS — email_templates account isolation', () => {
  let companyAId: string;
  let companyBId: string;

  beforeEach(async () => {
    await resetDb();
    await seedTwoTenants();
    ({ companyAId, companyBId } = await seedEmailTemplates());
  });

  it('sees only its own account templates when context is set', async () => {
    const seen = await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      return tx.select().from(emailTemplates);
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.accountId).toBe(accountAId);
    expect(seen[0]?.subject).toBe('A');
  });

  it('sees no rows when no account context is set', async () => {
    const seen = await getAppDb().select().from(emailTemplates);
    expect(seen).toEqual([]);
  });

  it('allows insert with matching account_id', async () => {
    const id = uuidv7();
    await expect(
      withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
        await tx.insert(emailTemplates).values({
          id,
          accountId: accountAId,
          companyId: companyAId,
          type: 'estimate',
          subject: 'A Estimate',
          body: 'x',
        });
      }),
    ).resolves.not.toThrow();
    const found = await getTestDb().select().from(emailTemplates).where(eq(emailTemplates.id, id));
    expect(found).toHaveLength(1);
  });

  it('blocks insert with a foreign account_id (WITH CHECK violation)', async () => {
    const smuggledId = uuidv7();
    await expect(
      withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
        await tx.insert(emailTemplates).values({
          id: smuggledId,
          accountId: accountBId,
          companyId: companyBId,
          type: 'estimate',
          subject: 'Smuggled',
          body: 'x',
        });
      }),
    ).rejects.toThrow();
    const found = await getTestDb()
      .select()
      .from(emailTemplates)
      .where(eq(emailTemplates.id, smuggledId));
    expect(found).toEqual([]);
  });

  it('cannot UPDATE templates in another account', async () => {
    await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      await tx
        .update(emailTemplates)
        .set({ subject: 'pwned' })
        .where(eq(emailTemplates.accountId, accountBId));
    });
    const bRows = await getTestDb()
      .select()
      .from(emailTemplates)
      .where(eq(emailTemplates.accountId, accountBId));
    expect(bRows[0]?.subject).toBe('B');
  });

  it('cannot DELETE templates in another account', async () => {
    await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      await tx.delete(emailTemplates).where(eq(emailTemplates.accountId, accountBId));
    });
    const bRows = await getTestDb()
      .select()
      .from(emailTemplates)
      .where(eq(emailTemplates.accountId, accountBId));
    expect(bRows).toHaveLength(1);
  });
});

describe('RLS — email_templates under staff_readonly', () => {
  beforeEach(async () => {
    await resetDb();
    await seedTwoTenants();
    await seedEmailTemplates();
  });

  it('reads templates across accounts (BYPASSRLS)', async () => {
    const seen = await getStaffDb().select().from(emailTemplates);
    expect(seen).toHaveLength(2);
  });

  it('cannot UPDATE (privilege denied)', async () => {
    await expect(
      getStaffDb()
        .update(emailTemplates)
        .set({ subject: 'pwned' })
        .where(eq(emailTemplates.accountId, accountAId)),
    ).rejects.toThrow();
  });
});

// invoices + invoice_line_items: both carry account_id (denormalized for the
// uniform NULLIF RLS idiom). Same shape as contacts — app role gets full CRUD
// within its tenant; staff_readonly bypasses RLS for SELECT only.

async function seedInvoicesAndLines(): Promise<{
  companyAId: string;
  companyBId: string;
  contactAId: string;
  contactBId: string;
  invoiceAId: string;
  invoiceBId: string;
}> {
  const db = getTestDb();
  const [companyA] = await db.select().from(companies).where(eq(companies.accountId, accountAId));
  const [companyB] = await db.select().from(companies).where(eq(companies.accountId, accountBId));
  if (!companyA || !companyB) throw new Error('seedTwoTenants did not produce one company each');

  const contactAId = uuidv7();
  const contactBId = uuidv7();
  await db.insert(contacts).values([
    { id: contactAId, accountId: accountAId, companyId: companyA.id, name: 'A Contact' },
    { id: contactBId, accountId: accountBId, companyId: companyB.id, name: 'B Contact' },
  ]);

  const invoiceAId = uuidv7();
  const invoiceBId = uuidv7();
  await db.insert(invoices).values([
    {
      id: invoiceAId,
      accountId: accountAId,
      companyId: companyA.id,
      contactId: contactAId,
      number: 'INV-A1',
      issueDate: '2026-05-23',
      dueDate: '2026-06-22',
      total: '100.00',
    },
    {
      id: invoiceBId,
      accountId: accountBId,
      companyId: companyB.id,
      contactId: contactBId,
      number: 'INV-B1',
      issueDate: '2026-05-23',
      dueDate: '2026-06-22',
      total: '50.00',
    },
  ]);
  await db.insert(invoiceLineItems).values([
    {
      id: uuidv7(),
      accountId: accountAId,
      invoiceId: invoiceAId,
      position: 1,
      description: 'A line',
      quantity: '1',
      unitPrice: '100.00',
      amount: '100.00',
    },
    {
      id: uuidv7(),
      accountId: accountBId,
      invoiceId: invoiceBId,
      position: 1,
      description: 'B line',
      quantity: '1',
      unitPrice: '50.00',
      amount: '50.00',
    },
  ]);

  return {
    companyAId: companyA.id,
    companyBId: companyB.id,
    contactAId,
    contactBId,
    invoiceAId,
    invoiceBId,
  };
}

describe('RLS — invoices account isolation', () => {
  let companyAId: string;
  let companyBId: string;
  let contactAId: string;
  let contactBId: string;

  beforeEach(async () => {
    await resetDb();
    await seedTwoTenants();
    ({ companyAId, companyBId, contactAId, contactBId } = await seedInvoicesAndLines());
  });

  it('sees only its own account invoices when context is set', async () => {
    const seen = await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      return tx.select().from(invoices);
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.accountId).toBe(accountAId);
    expect(seen[0]?.number).toBe('INV-A1');
  });

  it('sees no rows when no account context is set', async () => {
    const seen = await getAppDb().select().from(invoices);
    expect(seen).toEqual([]);
  });

  it('allows insert with matching account_id', async () => {
    const id = uuidv7();
    await expect(
      withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
        await tx.insert(invoices).values({
          id,
          accountId: accountAId,
          companyId: companyAId,
          contactId: contactAId,
          number: 'INV-A2',
          issueDate: '2026-05-23',
          dueDate: '2026-06-22',
        });
      }),
    ).resolves.not.toThrow();
    const found = await getTestDb().select().from(invoices).where(eq(invoices.id, id));
    expect(found).toHaveLength(1);
  });

  it('blocks insert with a foreign account_id (WITH CHECK violation)', async () => {
    const smuggledId = uuidv7();
    await expect(
      withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
        await tx.insert(invoices).values({
          id: smuggledId,
          accountId: accountBId,
          companyId: companyBId,
          contactId: contactBId,
          number: 'INV-SMUGGLED',
          issueDate: '2026-05-23',
          dueDate: '2026-06-22',
        });
      }),
    ).rejects.toThrow();
    const found = await getTestDb().select().from(invoices).where(eq(invoices.id, smuggledId));
    expect(found).toEqual([]);
  });

  it('cannot UPDATE invoices in another account', async () => {
    await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      await tx.update(invoices).set({ status: 'paid' }).where(eq(invoices.accountId, accountBId));
    });
    const bRows = await getTestDb()
      .select()
      .from(invoices)
      .where(eq(invoices.accountId, accountBId));
    expect(bRows[0]?.status).toBe('draft');
  });

  it('cannot DELETE invoices in another account', async () => {
    await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      await tx.delete(invoices).where(eq(invoices.accountId, accountBId));
    });
    const bRows = await getTestDb()
      .select()
      .from(invoices)
      .where(eq(invoices.accountId, accountBId));
    expect(bRows).toHaveLength(1);
  });

  it('allows tenant-scoped DELETE within own account', async () => {
    await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      await tx.delete(invoices).where(eq(invoices.accountId, accountAId));
    });
    const aRows = await getTestDb()
      .select()
      .from(invoices)
      .where(eq(invoices.accountId, accountAId));
    expect(aRows).toEqual([]);
  });
});

describe('RLS — invoice_line_items account isolation', () => {
  let invoiceAId: string;
  let invoiceBId: string;

  beforeEach(async () => {
    await resetDb();
    await seedTwoTenants();
    ({ invoiceAId, invoiceBId } = await seedInvoicesAndLines());
  });

  it('sees only its own account line items when context is set', async () => {
    const seen = await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      return tx.select().from(invoiceLineItems);
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.accountId).toBe(accountAId);
    expect(seen[0]?.description).toBe('A line');
  });

  it('sees no rows when no account context is set', async () => {
    const seen = await getAppDb().select().from(invoiceLineItems);
    expect(seen).toEqual([]);
  });

  it('allows insert with matching account_id', async () => {
    const id = uuidv7();
    await expect(
      withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
        await tx.insert(invoiceLineItems).values({
          id,
          accountId: accountAId,
          invoiceId: invoiceAId,
          position: 2,
          description: 'A second line',
          quantity: '1',
          unitPrice: '25.00',
          amount: '25.00',
        });
      }),
    ).resolves.not.toThrow();
    const found = await getTestDb()
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.id, id));
    expect(found).toHaveLength(1);
  });

  it('blocks insert pointing line item at a foreign-tenant invoice (WITH CHECK)', async () => {
    const smuggledId = uuidv7();
    await expect(
      withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
        await tx.insert(invoiceLineItems).values({
          id: smuggledId,
          accountId: accountBId,
          invoiceId: invoiceBId,
          position: 99,
          description: 'Smuggled',
          quantity: '1',
          unitPrice: '0.01',
          amount: '0.01',
        });
      }),
    ).rejects.toThrow();
    const found = await getTestDb()
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.id, smuggledId));
    expect(found).toEqual([]);
  });

  it('cannot DELETE line items in another account', async () => {
    await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      await tx.delete(invoiceLineItems).where(eq(invoiceLineItems.accountId, accountBId));
    });
    const bRows = await getTestDb()
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.accountId, accountBId));
    expect(bRows).toHaveLength(1);
  });
});

describe('RLS — invoices + line items under staff_readonly', () => {
  beforeEach(async () => {
    await resetDb();
    await seedTwoTenants();
    await seedInvoicesAndLines();
  });

  it('reads invoices across accounts (BYPASSRLS)', async () => {
    const seen = await getStaffDb().select().from(invoices);
    expect(seen).toHaveLength(2);
  });

  it('reads line items across accounts (BYPASSRLS)', async () => {
    const seen = await getStaffDb().select().from(invoiceLineItems);
    expect(seen).toHaveLength(2);
  });

  it('cannot INSERT invoices (privilege denied)', async () => {
    const [companyA] = await getTestDb()
      .select()
      .from(companies)
      .where(eq(companies.accountId, accountAId));
    const [contactA] = await getTestDb()
      .select()
      .from(contacts)
      .where(eq(contacts.accountId, accountAId));
    await expect(
      getStaffDb().insert(invoices).values({
        id: uuidv7(),
        accountId: accountAId,
        // biome-ignore lint/style/noNonNullAssertion: seeded above
        companyId: companyA!.id,
        // biome-ignore lint/style/noNonNullAssertion: seeded above
        contactId: contactA!.id,
        number: 'INV-STAFF',
        issueDate: '2026-05-23',
        dueDate: '2026-06-22',
      }),
    ).rejects.toThrow();
  });

  it('cannot DELETE invoices (privilege denied)', async () => {
    await expect(getStaffDb().delete(invoices)).rejects.toThrow();
    const rows = await getTestDb().select().from(invoices);
    expect(rows).toHaveLength(2);
  });
});

// estimates + estimate_line_items mirror invoices for RLS purposes: both carry
// account_id directly and use the standard NULLIF tenant idiom. App role gets
// full CRUD within its tenant; staff_readonly bypasses RLS for SELECT only.

async function seedEstimatesAndLines(): Promise<{
  companyAId: string;
  companyBId: string;
  contactAId: string;
  contactBId: string;
  estimateAId: string;
  estimateBId: string;
}> {
  const db = getTestDb();
  const [companyA] = await db.select().from(companies).where(eq(companies.accountId, accountAId));
  const [companyB] = await db.select().from(companies).where(eq(companies.accountId, accountBId));
  if (!companyA || !companyB) throw new Error('seedTwoTenants did not produce one company each');

  const contactAId = uuidv7();
  const contactBId = uuidv7();
  await db.insert(contacts).values([
    { id: contactAId, accountId: accountAId, companyId: companyA.id, name: 'A Contact' },
    { id: contactBId, accountId: accountBId, companyId: companyB.id, name: 'B Contact' },
  ]);

  const estimateAId = uuidv7();
  const estimateBId = uuidv7();
  await db.insert(estimates).values([
    {
      id: estimateAId,
      accountId: accountAId,
      companyId: companyA.id,
      contactId: contactAId,
      number: 'EST-A1',
      issueDate: '2026-05-23',
      total: '100.00',
    },
    {
      id: estimateBId,
      accountId: accountBId,
      companyId: companyB.id,
      contactId: contactBId,
      number: 'EST-B1',
      issueDate: '2026-05-23',
      total: '50.00',
    },
  ]);
  await db.insert(estimateLineItems).values([
    {
      id: uuidv7(),
      accountId: accountAId,
      estimateId: estimateAId,
      position: 1,
      description: 'A line',
      quantity: '1',
      unitPrice: '100.00',
      amount: '100.00',
    },
    {
      id: uuidv7(),
      accountId: accountBId,
      estimateId: estimateBId,
      position: 1,
      description: 'B line',
      quantity: '1',
      unitPrice: '50.00',
      amount: '50.00',
    },
  ]);

  return {
    companyAId: companyA.id,
    companyBId: companyB.id,
    contactAId,
    contactBId,
    estimateAId,
    estimateBId,
  };
}

describe('RLS — estimates account isolation', () => {
  let companyAId: string;
  let companyBId: string;
  let contactAId: string;
  let contactBId: string;

  beforeEach(async () => {
    await resetDb();
    await seedTwoTenants();
    ({ companyAId, companyBId, contactAId, contactBId } = await seedEstimatesAndLines());
  });

  it('sees only its own account estimates when context is set', async () => {
    const seen = await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      return tx.select().from(estimates);
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.accountId).toBe(accountAId);
    expect(seen[0]?.number).toBe('EST-A1');
  });

  it('sees no rows when no account context is set', async () => {
    const seen = await getAppDb().select().from(estimates);
    expect(seen).toEqual([]);
  });

  it('allows insert with matching account_id', async () => {
    const id = uuidv7();
    await expect(
      withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
        await tx.insert(estimates).values({
          id,
          accountId: accountAId,
          companyId: companyAId,
          contactId: contactAId,
          number: 'EST-A2',
          issueDate: '2026-05-23',
        });
      }),
    ).resolves.not.toThrow();
    const found = await getTestDb().select().from(estimates).where(eq(estimates.id, id));
    expect(found).toHaveLength(1);
  });

  it('blocks insert with a foreign account_id (WITH CHECK violation)', async () => {
    const smuggledId = uuidv7();
    await expect(
      withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
        await tx.insert(estimates).values({
          id: smuggledId,
          accountId: accountBId,
          companyId: companyBId,
          contactId: contactBId,
          number: 'EST-SMUGGLED',
          issueDate: '2026-05-23',
        });
      }),
    ).rejects.toThrow();
    const found = await getTestDb().select().from(estimates).where(eq(estimates.id, smuggledId));
    expect(found).toEqual([]);
  });

  it('cannot UPDATE estimates in another account', async () => {
    await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      await tx
        .update(estimates)
        .set({ status: 'accepted' })
        .where(eq(estimates.accountId, accountBId));
    });
    const bRows = await getTestDb()
      .select()
      .from(estimates)
      .where(eq(estimates.accountId, accountBId));
    expect(bRows[0]?.status).toBe('draft');
  });

  it('cannot DELETE estimates in another account', async () => {
    await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      await tx.delete(estimates).where(eq(estimates.accountId, accountBId));
    });
    const bRows = await getTestDb()
      .select()
      .from(estimates)
      .where(eq(estimates.accountId, accountBId));
    expect(bRows).toHaveLength(1);
  });

  it('allows tenant-scoped DELETE within own account', async () => {
    await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      await tx.delete(estimates).where(eq(estimates.accountId, accountAId));
    });
    const aRows = await getTestDb()
      .select()
      .from(estimates)
      .where(eq(estimates.accountId, accountAId));
    expect(aRows).toEqual([]);
  });
});

describe('RLS — estimate_line_items account isolation', () => {
  let estimateAId: string;
  let estimateBId: string;

  beforeEach(async () => {
    await resetDb();
    await seedTwoTenants();
    ({ estimateAId, estimateBId } = await seedEstimatesAndLines());
  });

  it('sees only its own account line items when context is set', async () => {
    const seen = await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      return tx.select().from(estimateLineItems);
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.accountId).toBe(accountAId);
    expect(seen[0]?.description).toBe('A line');
  });

  it('sees no rows when no account context is set', async () => {
    const seen = await getAppDb().select().from(estimateLineItems);
    expect(seen).toEqual([]);
  });

  it('allows insert with matching account_id', async () => {
    const id = uuidv7();
    await expect(
      withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
        await tx.insert(estimateLineItems).values({
          id,
          accountId: accountAId,
          estimateId: estimateAId,
          position: 2,
          description: 'A second line',
          quantity: '1',
          unitPrice: '25.00',
          amount: '25.00',
        });
      }),
    ).resolves.not.toThrow();
    const found = await getTestDb()
      .select()
      .from(estimateLineItems)
      .where(eq(estimateLineItems.id, id));
    expect(found).toHaveLength(1);
  });

  it('blocks insert pointing line item at a foreign-tenant estimate (WITH CHECK)', async () => {
    const smuggledId = uuidv7();
    await expect(
      withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
        await tx.insert(estimateLineItems).values({
          id: smuggledId,
          accountId: accountBId,
          estimateId: estimateBId,
          position: 99,
          description: 'Smuggled',
          quantity: '1',
          unitPrice: '0.01',
          amount: '0.01',
        });
      }),
    ).rejects.toThrow();
    const found = await getTestDb()
      .select()
      .from(estimateLineItems)
      .where(eq(estimateLineItems.id, smuggledId));
    expect(found).toEqual([]);
  });

  it('cannot DELETE line items in another account', async () => {
    await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      await tx.delete(estimateLineItems).where(eq(estimateLineItems.accountId, accountBId));
    });
    const bRows = await getTestDb()
      .select()
      .from(estimateLineItems)
      .where(eq(estimateLineItems.accountId, accountBId));
    expect(bRows).toHaveLength(1);
  });
});

describe('RLS — estimates + line items under staff_readonly', () => {
  beforeEach(async () => {
    await resetDb();
    await seedTwoTenants();
    await seedEstimatesAndLines();
  });

  it('reads estimates across accounts (BYPASSRLS)', async () => {
    const seen = await getStaffDb().select().from(estimates);
    expect(seen).toHaveLength(2);
  });

  it('reads line items across accounts (BYPASSRLS)', async () => {
    const seen = await getStaffDb().select().from(estimateLineItems);
    expect(seen).toHaveLength(2);
  });

  it('cannot INSERT estimates (privilege denied)', async () => {
    const [companyA] = await getTestDb()
      .select()
      .from(companies)
      .where(eq(companies.accountId, accountAId));
    const [contactA] = await getTestDb()
      .select()
      .from(contacts)
      .where(eq(contacts.accountId, accountAId));
    await expect(
      getStaffDb().insert(estimates).values({
        id: uuidv7(),
        accountId: accountAId,
        // biome-ignore lint/style/noNonNullAssertion: seeded above
        companyId: companyA!.id,
        // biome-ignore lint/style/noNonNullAssertion: seeded above
        contactId: contactA!.id,
        number: 'EST-STAFF',
        issueDate: '2026-05-23',
      }),
    ).rejects.toThrow();
  });

  it('cannot DELETE estimates (privilege denied)', async () => {
    await expect(getStaffDb().delete(estimates)).rejects.toThrow();
    const rows = await getTestDb().select().from(estimates);
    expect(rows).toHaveLength(2);
  });
});

// expenses: third MVP entity (slice 8.9a). Carries account_id directly; FKs
// reach chart_of_accounts for both category + payment legs, customer_contact_id
// optional. Same NULLIF tenant-isolation idiom as the rest of the schema.

async function seedExpensesPerAccount(): Promise<{
  companyAId: string;
  companyBId: string;
  cashAccountAId: string;
  suppliesAccountAId: string;
  cashAccountBId: string;
  suppliesAccountBId: string;
  expenseAId: string;
  expenseBId: string;
}> {
  const db = getTestDb();
  const [companyA] = await db.select().from(companies).where(eq(companies.accountId, accountAId));
  const [companyB] = await db.select().from(companies).where(eq(companies.accountId, accountBId));
  if (!companyA || !companyB) throw new Error('seedTwoTenants did not produce one company each');

  await seedChartOfAccounts(db, { accountId: accountAId, companyId: companyA.id });
  await seedChartOfAccounts(db, { accountId: accountBId, companyId: companyB.id });

  const aCoa = await db
    .select()
    .from(chartOfAccounts)
    .where(eq(chartOfAccounts.companyId, companyA.id));
  const bCoa = await db
    .select()
    .from(chartOfAccounts)
    .where(eq(chartOfAccounts.companyId, companyB.id));
  const cashA = aCoa.find((r) => r.code === '1000');
  const suppliesA = aCoa.find((r) => r.code === '7000');
  const cashB = bCoa.find((r) => r.code === '1000');
  const suppliesB = bCoa.find((r) => r.code === '7000');
  if (!cashA || !suppliesA || !cashB || !suppliesB) {
    throw new Error('COA seed missing expected accounts');
  }

  const expenseAId = uuidv7();
  const expenseBId = uuidv7();
  await db.insert(expenses).values([
    {
      id: expenseAId,
      accountId: accountAId,
      companyId: companyA.id,
      categoryAccountId: suppliesA.id,
      paymentAccountId: cashA.id,
      amount: '25.00',
      expenseDate: '2026-05-30',
      merchant: 'A Vendor',
    },
    {
      id: expenseBId,
      accountId: accountBId,
      companyId: companyB.id,
      categoryAccountId: suppliesB.id,
      paymentAccountId: cashB.id,
      amount: '50.00',
      expenseDate: '2026-05-30',
      merchant: 'B Vendor',
    },
  ]);

  return {
    companyAId: companyA.id,
    companyBId: companyB.id,
    cashAccountAId: cashA.id,
    suppliesAccountAId: suppliesA.id,
    cashAccountBId: cashB.id,
    suppliesAccountBId: suppliesB.id,
    expenseAId,
    expenseBId,
  };
}

describe('RLS — expenses account isolation', () => {
  let companyAId: string;
  let companyBId: string;
  let cashAccountAId: string;
  let suppliesAccountAId: string;
  let suppliesAccountBId: string;
  let cashAccountBId: string;

  beforeEach(async () => {
    await resetDb();
    await seedTwoTenants();
    ({
      companyAId,
      companyBId,
      cashAccountAId,
      suppliesAccountAId,
      cashAccountBId,
      suppliesAccountBId,
    } = await seedExpensesPerAccount());
  });

  it('sees only its own account expenses when context is set', async () => {
    const seen = await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      return tx.select().from(expenses);
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.accountId).toBe(accountAId);
    expect(seen[0]?.merchant).toBe('A Vendor');
  });

  it('sees no rows when no account context is set', async () => {
    const seen = await getAppDb().select().from(expenses);
    expect(seen).toEqual([]);
  });

  it('allows insert with matching account_id', async () => {
    const id = uuidv7();
    await expect(
      withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
        await tx.insert(expenses).values({
          id,
          accountId: accountAId,
          companyId: companyAId,
          categoryAccountId: suppliesAccountAId,
          paymentAccountId: cashAccountAId,
          amount: '10.00',
          expenseDate: '2026-05-30',
          merchant: 'Within tenant',
        });
      }),
    ).resolves.not.toThrow();
    const found = await getTestDb().select().from(expenses).where(eq(expenses.id, id));
    expect(found).toHaveLength(1);
  });

  it('blocks insert with a foreign account_id (WITH CHECK violation)', async () => {
    const smuggledId = uuidv7();
    await expect(
      withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
        await tx.insert(expenses).values({
          id: smuggledId,
          accountId: accountBId,
          companyId: companyBId,
          categoryAccountId: suppliesAccountBId,
          paymentAccountId: cashAccountBId,
          amount: '10.00',
          expenseDate: '2026-05-30',
          merchant: 'Smuggled',
        });
      }),
    ).rejects.toThrow();
    const found = await getTestDb().select().from(expenses).where(eq(expenses.id, smuggledId));
    expect(found).toEqual([]);
  });

  it('cannot UPDATE expenses in another account', async () => {
    await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      await tx
        .update(expenses)
        .set({ merchant: 'pwned' })
        .where(eq(expenses.accountId, accountBId));
    });
    const bRows = await getTestDb()
      .select()
      .from(expenses)
      .where(eq(expenses.accountId, accountBId));
    expect(bRows[0]?.merchant).toBe('B Vendor');
  });

  it('cannot DELETE expenses in another account', async () => {
    await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      await tx.delete(expenses).where(eq(expenses.accountId, accountBId));
    });
    const bRows = await getTestDb()
      .select()
      .from(expenses)
      .where(eq(expenses.accountId, accountBId));
    expect(bRows).toHaveLength(1);
  });

  it('allows tenant-scoped soft delete via UPDATE deleted_at within own account', async () => {
    await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      await tx
        .update(expenses)
        .set({ deletedAt: new Date() })
        .where(eq(expenses.accountId, accountAId));
    });
    const aRows = await getTestDb()
      .select()
      .from(expenses)
      .where(eq(expenses.accountId, accountAId));
    expect(aRows[0]?.deletedAt).toBeInstanceOf(Date);
  });
});

describe('RLS — expenses under staff_readonly', () => {
  beforeEach(async () => {
    await resetDb();
    await seedTwoTenants();
    await seedExpensesPerAccount();
  });

  it('reads expenses across accounts (BYPASSRLS)', async () => {
    const seen = await getStaffDb().select().from(expenses);
    expect(seen).toHaveLength(2);
  });

  it('cannot INSERT expenses (privilege denied)', async () => {
    const [companyA] = await getTestDb()
      .select()
      .from(companies)
      .where(eq(companies.accountId, accountAId));
    const aCoa = await getTestDb()
      .select()
      .from(chartOfAccounts)
      // biome-ignore lint/style/noNonNullAssertion: seeded above
      .where(eq(chartOfAccounts.companyId, companyA!.id));
    const cash = aCoa.find((r) => r.code === '1000');
    const supplies = aCoa.find((r) => r.code === '7000');
    await expect(
      getStaffDb().insert(expenses).values({
        id: uuidv7(),
        accountId: accountAId,
        // biome-ignore lint/style/noNonNullAssertion: seeded above
        companyId: companyA!.id,
        // biome-ignore lint/style/noNonNullAssertion: seeded above
        categoryAccountId: supplies!.id,
        // biome-ignore lint/style/noNonNullAssertion: seeded above
        paymentAccountId: cash!.id,
        amount: '10.00',
        expenseDate: '2026-05-30',
        merchant: 'Staff Wuz Here',
      }),
    ).rejects.toThrow();
  });

  it('cannot DELETE expenses (privilege denied)', async () => {
    await expect(getStaffDb().delete(expenses)).rejects.toThrow();
    const rows = await getTestDb().select().from(expenses);
    expect(rows).toHaveLength(2);
  });
});

// recurring_invoices + recurring_invoice_line_items: the schedule template
// tables (slice R1). Both carry account_id directly and use the standard
// NULLIF tenant idiom. App role gets full CRUD within its tenant; the sweeper
// writes generated invoices under withAccountContext so it's gated like any
// other tenant write. staff_readonly bypasses RLS for SELECT only.

async function seedRecurringAndLines(): Promise<{
  companyAId: string;
  companyBId: string;
  contactAId: string;
  contactBId: string;
  recurringAId: string;
  recurringBId: string;
}> {
  const db = getTestDb();
  const [companyA] = await db.select().from(companies).where(eq(companies.accountId, accountAId));
  const [companyB] = await db.select().from(companies).where(eq(companies.accountId, accountBId));
  if (!companyA || !companyB) throw new Error('seedTwoTenants did not produce one company each');

  const contactAId = uuidv7();
  const contactBId = uuidv7();
  await db.insert(contacts).values([
    { id: contactAId, accountId: accountAId, companyId: companyA.id, name: 'A Contact' },
    { id: contactBId, accountId: accountBId, companyId: companyB.id, name: 'B Contact' },
  ]);

  const recurringAId = uuidv7();
  const recurringBId = uuidv7();
  await db.insert(recurringInvoices).values([
    {
      id: recurringAId,
      accountId: accountAId,
      companyId: companyA.id,
      contactId: contactAId,
      frequency: 'monthly',
      startDate: '2026-06-01',
      nextRunDate: '2026-06-01',
      total: '100.00',
    },
    {
      id: recurringBId,
      accountId: accountBId,
      companyId: companyB.id,
      contactId: contactBId,
      frequency: 'weekly',
      startDate: '2026-06-01',
      nextRunDate: '2026-06-01',
      total: '50.00',
    },
  ]);
  await db.insert(recurringInvoiceLineItems).values([
    {
      id: uuidv7(),
      accountId: accountAId,
      recurringInvoiceId: recurringAId,
      position: 1,
      description: 'A line',
      quantity: '1',
      unitPrice: '100.00',
      amount: '100.00',
    },
    {
      id: uuidv7(),
      accountId: accountBId,
      recurringInvoiceId: recurringBId,
      position: 1,
      description: 'B line',
      quantity: '1',
      unitPrice: '50.00',
      amount: '50.00',
    },
  ]);

  return {
    companyAId: companyA.id,
    companyBId: companyB.id,
    contactAId,
    contactBId,
    recurringAId,
    recurringBId,
  };
}

describe('RLS — recurring_invoices account isolation', () => {
  let companyAId: string;
  let companyBId: string;
  let contactAId: string;
  let contactBId: string;

  beforeEach(async () => {
    await resetDb();
    await seedTwoTenants();
    ({ companyAId, companyBId, contactAId, contactBId } = await seedRecurringAndLines());
  });

  it('sees only its own account schedules when context is set', async () => {
    const seen = await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      return tx.select().from(recurringInvoices);
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.accountId).toBe(accountAId);
    expect(seen[0]?.frequency).toBe('monthly');
  });

  it('sees no rows when no account context is set', async () => {
    const seen = await getAppDb().select().from(recurringInvoices);
    expect(seen).toEqual([]);
  });

  it('allows insert with matching account_id', async () => {
    const id = uuidv7();
    await expect(
      withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
        await tx.insert(recurringInvoices).values({
          id,
          accountId: accountAId,
          companyId: companyAId,
          contactId: contactAId,
          frequency: 'yearly',
          startDate: '2026-06-01',
          nextRunDate: '2026-06-01',
        });
      }),
    ).resolves.not.toThrow();
    const found = await getTestDb()
      .select()
      .from(recurringInvoices)
      .where(eq(recurringInvoices.id, id));
    expect(found).toHaveLength(1);
  });

  it('blocks insert with a foreign account_id (WITH CHECK violation)', async () => {
    const smuggledId = uuidv7();
    await expect(
      withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
        await tx.insert(recurringInvoices).values({
          id: smuggledId,
          accountId: accountBId,
          companyId: companyBId,
          contactId: contactBId,
          frequency: 'monthly',
          startDate: '2026-06-01',
          nextRunDate: '2026-06-01',
        });
      }),
    ).rejects.toThrow();
    const found = await getTestDb()
      .select()
      .from(recurringInvoices)
      .where(eq(recurringInvoices.id, smuggledId));
    expect(found).toEqual([]);
  });

  it('rejects an out-of-enum frequency (CHECK constraint)', async () => {
    await expect(
      withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
        await tx.insert(recurringInvoices).values({
          id: uuidv7(),
          accountId: accountAId,
          companyId: companyAId,
          contactId: contactAId,
          frequency: 'fortnightly',
          startDate: '2026-06-01',
          nextRunDate: '2026-06-01',
        });
      }),
    ).rejects.toThrow();
  });

  it('cannot UPDATE schedules in another account', async () => {
    await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      await tx
        .update(recurringInvoices)
        .set({ status: 'ended' })
        .where(eq(recurringInvoices.accountId, accountBId));
    });
    const bRows = await getTestDb()
      .select()
      .from(recurringInvoices)
      .where(eq(recurringInvoices.accountId, accountBId));
    expect(bRows[0]?.status).toBe('active');
  });

  it('cannot DELETE schedules in another account', async () => {
    await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      await tx.delete(recurringInvoices).where(eq(recurringInvoices.accountId, accountBId));
    });
    const bRows = await getTestDb()
      .select()
      .from(recurringInvoices)
      .where(eq(recurringInvoices.accountId, accountBId));
    expect(bRows).toHaveLength(1);
  });

  it('allows tenant-scoped DELETE within own account', async () => {
    await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      await tx.delete(recurringInvoices).where(eq(recurringInvoices.accountId, accountAId));
    });
    const aRows = await getTestDb()
      .select()
      .from(recurringInvoices)
      .where(eq(recurringInvoices.accountId, accountAId));
    expect(aRows).toEqual([]);
  });
});

describe('RLS — recurring_invoice_line_items account isolation', () => {
  let recurringAId: string;
  let recurringBId: string;

  beforeEach(async () => {
    await resetDb();
    await seedTwoTenants();
    ({ recurringAId, recurringBId } = await seedRecurringAndLines());
  });

  it('sees only its own account line items when context is set', async () => {
    const seen = await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      return tx.select().from(recurringInvoiceLineItems);
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.accountId).toBe(accountAId);
    expect(seen[0]?.description).toBe('A line');
  });

  it('sees no rows when no account context is set', async () => {
    const seen = await getAppDb().select().from(recurringInvoiceLineItems);
    expect(seen).toEqual([]);
  });

  it('allows insert with matching account_id', async () => {
    const id = uuidv7();
    await expect(
      withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
        await tx.insert(recurringInvoiceLineItems).values({
          id,
          accountId: accountAId,
          recurringInvoiceId: recurringAId,
          position: 2,
          description: 'A second line',
          quantity: '1',
          unitPrice: '25.00',
          amount: '25.00',
        });
      }),
    ).resolves.not.toThrow();
    const found = await getTestDb()
      .select()
      .from(recurringInvoiceLineItems)
      .where(eq(recurringInvoiceLineItems.id, id));
    expect(found).toHaveLength(1);
  });

  it('blocks insert pointing line item at a foreign-tenant schedule (WITH CHECK)', async () => {
    const smuggledId = uuidv7();
    await expect(
      withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
        await tx.insert(recurringInvoiceLineItems).values({
          id: smuggledId,
          accountId: accountBId,
          recurringInvoiceId: recurringBId,
          position: 99,
          description: 'Smuggled',
          quantity: '1',
          unitPrice: '0.01',
          amount: '0.01',
        });
      }),
    ).rejects.toThrow();
    const found = await getTestDb()
      .select()
      .from(recurringInvoiceLineItems)
      .where(eq(recurringInvoiceLineItems.id, smuggledId));
    expect(found).toEqual([]);
  });

  it('cannot DELETE line items in another account', async () => {
    await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      await tx
        .delete(recurringInvoiceLineItems)
        .where(eq(recurringInvoiceLineItems.accountId, accountBId));
    });
    const bRows = await getTestDb()
      .select()
      .from(recurringInvoiceLineItems)
      .where(eq(recurringInvoiceLineItems.accountId, accountBId));
    expect(bRows).toHaveLength(1);
  });
});

describe('RLS — recurring invoices + line items under staff_readonly', () => {
  beforeEach(async () => {
    await resetDb();
    await seedTwoTenants();
    await seedRecurringAndLines();
  });

  it('reads schedules across accounts (BYPASSRLS)', async () => {
    const seen = await getStaffDb().select().from(recurringInvoices);
    expect(seen).toHaveLength(2);
  });

  it('reads line items across accounts (BYPASSRLS)', async () => {
    const seen = await getStaffDb().select().from(recurringInvoiceLineItems);
    expect(seen).toHaveLength(2);
  });

  it('cannot INSERT schedules (privilege denied)', async () => {
    const [companyA] = await getTestDb()
      .select()
      .from(companies)
      .where(eq(companies.accountId, accountAId));
    const [contactA] = await getTestDb()
      .select()
      .from(contacts)
      .where(eq(contacts.accountId, accountAId));
    await expect(
      getStaffDb().insert(recurringInvoices).values({
        id: uuidv7(),
        accountId: accountAId,
        // biome-ignore lint/style/noNonNullAssertion: seeded above
        companyId: companyA!.id,
        // biome-ignore lint/style/noNonNullAssertion: seeded above
        contactId: contactA!.id,
        frequency: 'monthly',
        startDate: '2026-06-01',
        nextRunDate: '2026-06-01',
      }),
    ).rejects.toThrow();
  });

  it('cannot DELETE schedules (privilege denied)', async () => {
    await expect(getStaffDb().delete(recurringInvoices)).rejects.toThrow();
    const rows = await getTestDb().select().from(recurringInvoices);
    expect(rows).toHaveLength(2);
  });
});

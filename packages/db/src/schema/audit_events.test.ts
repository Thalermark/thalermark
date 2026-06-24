import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, resetDb } from '../../tests/db-test-helper.js';
import { accounts } from './accounts.js';
import { auditEvents } from './audit_events.js';
import { SYSTEM_USER_ID, authUser } from './auth.js';
import { companies } from './companies.js';

async function seedAccountAndUser() {
  const db = getTestDb();
  const accountId = uuidv7();
  const userId = uuidv7();
  const companyId = uuidv7();
  await db.insert(accounts).values({ id: accountId, name: 'Acct' });
  await db.insert(authUser).values({ id: userId, email: `actor-${userId}@example.com` });
  await db.insert(companies).values({ id: companyId, accountId, name: 'Co' });
  return { accountId, userId, companyId };
}

describe('audit_events — schema', () => {
  beforeEach(resetDb);

  it('inserts and reads back an event with before/after jsonb', async () => {
    const db = getTestDb();
    const { accountId, userId, companyId } = await seedAccountAndUser();
    const id = uuidv7();
    const entityId = uuidv7();

    await db.insert(auditEvents).values({
      id,
      accountId,
      companyId,
      actorUserId: userId,
      entityType: 'invoice',
      entityId,
      action: 'update',
      before: { status: 'draft' },
      after: { status: 'sent' },
    });

    const rows = await db.select().from(auditEvents).where(eq(auditEvents.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.entityType).toBe('invoice');
    expect(rows[0]?.action).toBe('update');
    expect(rows[0]?.before).toEqual({ status: 'draft' });
    expect(rows[0]?.after).toEqual({ status: 'sent' });
    expect(rows[0]?.createdAt).toBeInstanceOf(Date);
  });

  it('allows null company_id, before, after (create event with no company)', async () => {
    const db = getTestDb();
    const { accountId, userId } = await seedAccountAndUser();
    const id = uuidv7();

    await db.insert(auditEvents).values({
      id,
      accountId,
      actorUserId: userId,
      entityType: 'contact',
      entityId: uuidv7(),
      action: 'create',
      after: { name: 'Acme' },
    });

    const rows = await db.select().from(auditEvents).where(eq(auditEvents.id, id));
    expect(rows[0]?.companyId).toBeNull();
    expect(rows[0]?.before).toBeNull();
    expect(rows[0]?.after).toEqual({ name: 'Acme' });
  });
});

describe('audit_events — system user', () => {
  beforeEach(resetDb);

  it('seeds the system user with is_system = true', async () => {
    const db = getTestDb();
    const rows = await db.select().from(authUser).where(eq(authUser.id, SYSTEM_USER_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.isSystem).toBe(true);
    expect(rows[0]?.isStaff).toBe(false);
    expect(rows[0]?.email).toBe('system@thalermark.internal');
  });

  it('accepts system user as actor for system-initiated audit events', async () => {
    const db = getTestDb();
    const accountId = uuidv7();
    await db.insert(accounts).values({ id: accountId, name: 'Acct' });

    const id = uuidv7();
    await db.insert(auditEvents).values({
      id,
      accountId,
      actorUserId: SYSTEM_USER_ID,
      entityType: 'invoice',
      entityId: uuidv7(),
      action: 'invoice.auto_generated',
      after: { source: 'recurring_invoice_job' },
    });

    const rows = await db.select().from(auditEvents).where(eq(auditEvents.id, id));
    expect(rows[0]?.actorUserId).toBe(SYSTEM_USER_ID);
  });
});

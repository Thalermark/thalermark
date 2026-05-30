import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, resetDb } from '../../tests/db-test-helper.js';
import { accounts } from './accounts.js';
import { companies } from './companies.js';

describe('companies', () => {
  beforeEach(resetDb);

  it('inserts and reads back a company with FK to account', async () => {
    const db = getTestDb();
    const accountId = uuidv7();
    const companyId = uuidv7();

    await db.insert(accounts).values({ id: accountId, name: 'Test Account' });
    await db.insert(companies).values({ id: companyId, accountId, name: 'Test Company' });

    const rows = await db.select().from(companies).where(eq(companies.id, companyId));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.accountId).toBe(accountId);
    expect(rows[0]?.name).toBe('Test Company');
    expect(rows[0]?.createdAt).toBeInstanceOf(Date);
    expect(rows[0]?.updatedAt).toBeInstanceOf(Date);
  });

  it('rejects insert with non-existent account_id (FK constraint)', async () => {
    const db = getTestDb();

    await expect(
      db.insert(companies).values({
        id: uuidv7(),
        accountId: uuidv7(),
        name: 'Orphan Company',
      }),
    ).rejects.toThrow();
  });

  it('cascades delete: removing an account removes its companies', async () => {
    const db = getTestDb();
    const accountId = uuidv7();
    const companyId = uuidv7();

    await db.insert(accounts).values({ id: accountId, name: 'To Delete' });
    await db.insert(companies).values({ id: companyId, accountId, name: 'Cascaded' });

    await db.delete(accounts).where(eq(accounts.id, accountId));

    const remaining = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(remaining).toHaveLength(0);
  });

  it('defaults stripe connect fields to disabled / null on insert', async () => {
    const db = getTestDb();
    const accountId = uuidv7();
    const companyId = uuidv7();

    await db.insert(accounts).values({ id: accountId, name: 'Acct' });
    await db.insert(companies).values({ id: companyId, accountId, name: 'New' });

    const [row] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(row?.stripeConnectAccountId).toBeNull();
    expect(row?.stripeConnectChargesEnabled).toBe(false);
    expect(row?.stripeConnectDetailsSubmitted).toBe(false);
  });

  it('accepts each of the five business_type enum values + null', async () => {
    const db = getTestDb();
    const accountId = uuidv7();
    await db.insert(accounts).values({ id: accountId, name: 'Acct' });
    const values = [
      'sole_prop',
      'llc_single_member',
      'partnership',
      's_corp',
      'c_corp',
      null,
    ] as const;
    for (const bt of values) {
      await db
        .insert(companies)
        .values({ id: uuidv7(), accountId, name: `Co-${bt ?? 'null'}`, businessType: bt });
    }
  });

  it('rejects an unknown business_type with the CHECK constraint', async () => {
    const db = getTestDb();
    const accountId = uuidv7();
    await db.insert(accounts).values({ id: accountId, name: 'Acct' });
    await expect(
      db.insert(companies).values({
        id: uuidv7(),
        accountId,
        name: 'Bad',
        businessType: 'partnership_general',
      }),
    ).rejects.toThrow();
  });

  it('enforces uniqueness on stripe_connect_account_id (null allowed many times)', async () => {
    const db = getTestDb();
    const accountId = uuidv7();
    await db.insert(accounts).values({ id: accountId, name: 'Acct' });

    // Two companies with null connect ids — allowed (btree unique tolerates nulls).
    await db.insert(companies).values({ id: uuidv7(), accountId, name: 'A' });
    await db.insert(companies).values({ id: uuidv7(), accountId, name: 'B' });

    // First populated id is fine.
    await db
      .insert(companies)
      .values({ id: uuidv7(), accountId, name: 'C', stripeConnectAccountId: 'acct_dup' });

    // Second attempt with same id violates the unique index.
    await expect(
      db
        .insert(companies)
        .values({ id: uuidv7(), accountId, name: 'D', stripeConnectAccountId: 'acct_dup' }),
    ).rejects.toThrow();
  });
});

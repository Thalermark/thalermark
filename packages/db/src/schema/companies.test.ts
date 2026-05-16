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
});

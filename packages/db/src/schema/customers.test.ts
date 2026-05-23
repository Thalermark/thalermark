import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, resetDb } from '../../tests/db-test-helper.js';
import { accounts } from './accounts.js';
import { companies } from './companies.js';
import { customers } from './customers.js';

describe('customers', () => {
  beforeEach(resetDb);

  it('inserts and reads back a customer with FKs to account + company', async () => {
    const db = getTestDb();
    const accountId = uuidv7();
    const companyId = uuidv7();
    const customerId = uuidv7();

    await db.insert(accounts).values({ id: accountId, name: 'Acme' });
    await db.insert(companies).values({ id: companyId, accountId, name: 'Acme Co' });
    await db.insert(customers).values({
      id: customerId,
      accountId,
      companyId,
      name: 'Wile E. Coyote',
      email: 'wile@example.com',
      city: 'Tucson',
      region: 'AZ',
      country: 'US',
    });

    const [row] = await db.select().from(customers).where(eq(customers.id, customerId));
    expect(row?.name).toBe('Wile E. Coyote');
    expect(row?.email).toBe('wile@example.com');
    expect(row?.phone).toBeNull();
    expect(row?.city).toBe('Tucson');
    expect(row?.createdAt).toBeInstanceOf(Date);
  });

  it('rejects insert with non-existent account_id (FK constraint)', async () => {
    const db = getTestDb();
    const accountId = uuidv7();
    const companyId = uuidv7();

    await db.insert(accounts).values({ id: accountId, name: 'Acme' });
    await db.insert(companies).values({ id: companyId, accountId, name: 'Acme Co' });

    await expect(
      db.insert(customers).values({
        id: uuidv7(),
        accountId: uuidv7(), // not seeded
        companyId,
        name: 'Orphan',
      }),
    ).rejects.toThrow();
  });

  it('rejects insert with non-existent company_id (FK constraint)', async () => {
    const db = getTestDb();
    const accountId = uuidv7();

    await db.insert(accounts).values({ id: accountId, name: 'Acme' });

    await expect(
      db.insert(customers).values({
        id: uuidv7(),
        accountId,
        companyId: uuidv7(), // not seeded
        name: 'Orphan',
      }),
    ).rejects.toThrow();
  });

  it('cascades delete from accounts → customers', async () => {
    const db = getTestDb();
    const accountId = uuidv7();
    const companyId = uuidv7();
    const customerId = uuidv7();

    await db.insert(accounts).values({ id: accountId, name: 'Acme' });
    await db.insert(companies).values({ id: companyId, accountId, name: 'Acme Co' });
    await db
      .insert(customers)
      .values({ id: customerId, accountId, companyId, name: 'Cascade Target' });

    await db.delete(accounts).where(eq(accounts.id, accountId));

    const remaining = await db.select().from(customers).where(eq(customers.id, customerId));
    expect(remaining).toEqual([]);
  });

  it('cascades delete from companies → customers', async () => {
    const db = getTestDb();
    const accountId = uuidv7();
    const companyId = uuidv7();
    const customerId = uuidv7();

    await db.insert(accounts).values({ id: accountId, name: 'Acme' });
    await db.insert(companies).values({ id: companyId, accountId, name: 'Acme Co' });
    await db
      .insert(customers)
      .values({ id: customerId, accountId, companyId, name: 'Cascade Target' });

    await db.delete(companies).where(eq(companies.id, companyId));

    const remaining = await db.select().from(customers).where(eq(customers.id, customerId));
    expect(remaining).toEqual([]);
  });
});

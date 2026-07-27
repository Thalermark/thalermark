import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, resetDb } from '../../tests/db-test-helper.js';
import { seedChartOfAccounts } from '../seed/coa.js';
import { accounts } from './accounts.js';
import { bills } from './bills.js';
import { chartOfAccounts } from './chart_of_accounts.js';
import { companies } from './companies.js';
import { contacts } from './contacts.js';

async function seedTenant() {
  const db = getTestDb();
  const accountId = uuidv7();
  const companyId = uuidv7();
  const vendorId = uuidv7();
  await db.insert(accounts).values({ id: accountId, name: 'Acme' });
  await db.insert(companies).values({ id: companyId, accountId, name: 'Acme Co' });
  await db
    .insert(contacts)
    .values({ id: vendorId, accountId, companyId, name: 'Ace Hardware', isVendor: true });
  await seedChartOfAccounts(db, { accountId, companyId });
  const coa = await db
    .select()
    .from(chartOfAccounts)
    .where(eq(chartOfAccounts.companyId, companyId));
  const cash = coa.find((r) => r.code === '1000');
  const ap = coa.find((r) => r.code === '2000');
  const supplies = coa.find((r) => r.code === '7000');
  if (!cash || !ap || !supplies) throw new Error('COA seed missing expected accounts');
  return {
    accountId,
    companyId,
    vendorId,
    cashAccountId: cash.id,
    apAccountId: ap.id,
    suppliesAccountId: supplies.id,
  };
}

describe('bills', () => {
  beforeEach(resetDb);

  it('seeds Accounts Payable (2000) into the sole-prop COA', async () => {
    const { apAccountId } = await seedTenant();
    const db = getTestDb();
    const [ap] = await db.select().from(chartOfAccounts).where(eq(chartOfAccounts.id, apAccountId));
    expect(ap?.code).toBe('2000');
    expect(ap?.name).toBe('Accounts Payable');
    expect(ap?.accountType).toBe('liability');
    expect(ap?.normalBalance).toBe('credit');
  });

  it('inserts and reads back an open bill with sensible defaults', async () => {
    const db = getTestDb();
    const { accountId, companyId, vendorId, suppliesAccountId } = await seedTenant();
    const billId = uuidv7();

    await db.insert(bills).values({
      id: billId,
      accountId,
      companyId,
      contactId: vendorId,
      categoryAccountId: suppliesAccountId,
      amount: '320.00',
      billDate: '2026-06-01',
      dueDate: '2026-07-01',
      reference: 'INV-9912',
    });

    const [row] = await db.select().from(bills).where(eq(bills.id, billId));
    expect(row?.amount).toBe('320.00');
    expect(row?.billDate).toBe('2026-06-01');
    expect(row?.dueDate).toBe('2026-07-01');
    expect(row?.reference).toBe('INV-9912');
    expect(row?.status).toBe('open');
    expect(row?.currency).toBe('USD');
    expect(row?.paymentAccountId).toBeNull();
    expect(row?.paidAt).toBeNull();
    expect(row?.voidedAt).toBeNull();
    expect(row?.memo).toBeNull();
    expect(row?.createdAt).toBeInstanceOf(Date);
  });

  it('rejects amount <= 0 (CHECK constraint)', async () => {
    const db = getTestDb();
    const { accountId, companyId, vendorId, suppliesAccountId } = await seedTenant();

    for (const bad of ['0.00', '-5.00']) {
      await expect(
        db.insert(bills).values({
          id: uuidv7(),
          accountId,
          companyId,
          contactId: vendorId,
          categoryAccountId: suppliesAccountId,
          amount: bad,
          billDate: '2026-06-01',
          dueDate: '2026-07-01',
        }),
      ).rejects.toThrow();
    }
  });

  it('rejects insert with non-existent contact_id (FK)', async () => {
    const db = getTestDb();
    const { accountId, companyId, suppliesAccountId } = await seedTenant();

    await expect(
      db.insert(bills).values({
        id: uuidv7(),
        accountId,
        companyId,
        contactId: uuidv7(),
        categoryAccountId: suppliesAccountId,
        amount: '10.00',
        billDate: '2026-06-01',
        dueDate: '2026-07-01',
      }),
    ).rejects.toThrow();
  });

  it('rejects insert with non-existent category_account_id (FK)', async () => {
    const db = getTestDb();
    const { accountId, companyId, vendorId } = await seedTenant();

    await expect(
      db.insert(bills).values({
        id: uuidv7(),
        accountId,
        companyId,
        contactId: vendorId,
        categoryAccountId: uuidv7(),
        amount: '10.00',
        billDate: '2026-06-01',
        dueDate: '2026-07-01',
      }),
    ).rejects.toThrow();
  });
});

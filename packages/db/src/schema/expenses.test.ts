import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, resetDb } from '../../tests/db-test-helper.js';
import { seedChartOfAccounts } from '../seed/coa-sole-prop.js';
import { accounts } from './accounts.js';
import { chartOfAccounts } from './chart_of_accounts.js';
import { companies } from './companies.js';
import { contacts } from './contacts.js';
import { expenses } from './expenses.js';

async function seedTenant() {
  const db = getTestDb();
  const accountId = uuidv7();
  const companyId = uuidv7();
  await db.insert(accounts).values({ id: accountId, name: 'Acme' });
  await db.insert(companies).values({ id: companyId, accountId, name: 'Acme Co' });
  await seedChartOfAccounts(db, { accountId, companyId });
  const coa = await db
    .select()
    .from(chartOfAccounts)
    .where(eq(chartOfAccounts.companyId, companyId));
  const cash = coa.find((r) => r.code === '1000');
  const supplies = coa.find((r) => r.code === '7000');
  if (!cash || !supplies) throw new Error('COA seed missing expected accounts');
  return { accountId, companyId, cashAccountId: cash.id, suppliesAccountId: supplies.id };
}

describe('expenses', () => {
  beforeEach(resetDb);

  it('inserts and reads back an expense with default extraction_status', async () => {
    const db = getTestDb();
    const { accountId, companyId, cashAccountId, suppliesAccountId } = await seedTenant();
    const expenseId = uuidv7();

    await db.insert(expenses).values({
      id: expenseId,
      accountId,
      companyId,
      categoryAccountId: suppliesAccountId,
      paymentAccountId: cashAccountId,
      amount: '25.00',
      expenseDate: '2026-05-30',
      merchant: 'Home Depot',
    });

    const [row] = await db.select().from(expenses).where(eq(expenses.id, expenseId));
    expect(row?.merchant).toBe('Home Depot');
    expect(row?.amount).toBe('25.00');
    expect(row?.expenseDate).toBe('2026-05-30');
    expect(row?.customerContactId).toBeNull();
    expect(row?.memo).toBeNull();
    expect(row?.receiptStorageKey).toBeNull();
    expect(row?.receiptUploadedAt).toBeNull();
    expect(row?.extractionStatus).toBe('none');
    expect(row?.extractionPayload).toBeNull();
    expect(row?.deletedAt).toBeNull();
    expect(row?.createdAt).toBeInstanceOf(Date);
  });

  it('rejects amount <= 0 (CHECK constraint)', async () => {
    const db = getTestDb();
    const { accountId, companyId, cashAccountId, suppliesAccountId } = await seedTenant();

    await expect(
      db.insert(expenses).values({
        id: uuidv7(),
        accountId,
        companyId,
        categoryAccountId: suppliesAccountId,
        paymentAccountId: cashAccountId,
        amount: '0.00',
        expenseDate: '2026-05-30',
        merchant: 'Zero',
      }),
    ).rejects.toThrow();

    await expect(
      db.insert(expenses).values({
        id: uuidv7(),
        accountId,
        companyId,
        categoryAccountId: suppliesAccountId,
        paymentAccountId: cashAccountId,
        amount: '-5.00',
        expenseDate: '2026-05-30',
        merchant: 'Negative',
      }),
    ).rejects.toThrow();
  });

  it('rejects unknown extraction_status (CHECK constraint)', async () => {
    const db = getTestDb();
    const { accountId, companyId, cashAccountId, suppliesAccountId } = await seedTenant();

    await expect(
      db.insert(expenses).values({
        id: uuidv7(),
        accountId,
        companyId,
        categoryAccountId: suppliesAccountId,
        paymentAccountId: cashAccountId,
        amount: '10.00',
        expenseDate: '2026-05-30',
        merchant: 'Bad enum',
        extractionStatus: 'in_progress',
      }),
    ).rejects.toThrow();
  });

  it('accepts each valid extraction_status', async () => {
    const db = getTestDb();
    const { accountId, companyId, cashAccountId, suppliesAccountId } = await seedTenant();

    for (const status of ['none', 'pending', 'succeeded', 'failed'] as const) {
      await expect(
        db.insert(expenses).values({
          id: uuidv7(),
          accountId,
          companyId,
          categoryAccountId: suppliesAccountId,
          paymentAccountId: cashAccountId,
          amount: '10.00',
          expenseDate: '2026-05-30',
          merchant: `merchant ${status}`,
          extractionStatus: status,
        }),
      ).resolves.not.toThrow();
    }
  });

  it('rejects insert with non-existent category_account_id (FK)', async () => {
    const db = getTestDb();
    const { accountId, companyId, cashAccountId } = await seedTenant();

    await expect(
      db.insert(expenses).values({
        id: uuidv7(),
        accountId,
        companyId,
        categoryAccountId: uuidv7(),
        paymentAccountId: cashAccountId,
        amount: '10.00',
        expenseDate: '2026-05-30',
        merchant: 'Orphan category',
      }),
    ).rejects.toThrow();
  });

  it('rejects insert with non-existent payment_account_id (FK)', async () => {
    const db = getTestDb();
    const { accountId, companyId, suppliesAccountId } = await seedTenant();

    await expect(
      db.insert(expenses).values({
        id: uuidv7(),
        accountId,
        companyId,
        categoryAccountId: suppliesAccountId,
        paymentAccountId: uuidv7(),
        amount: '10.00',
        expenseDate: '2026-05-30',
        merchant: 'Orphan payment',
      }),
    ).rejects.toThrow();
  });

  it('blocks delete of a chart_of_accounts row referenced by an expense (RESTRICT)', async () => {
    const db = getTestDb();
    const { accountId, companyId, cashAccountId, suppliesAccountId } = await seedTenant();
    await db.insert(expenses).values({
      id: uuidv7(),
      accountId,
      companyId,
      categoryAccountId: suppliesAccountId,
      paymentAccountId: cashAccountId,
      amount: '10.00',
      expenseDate: '2026-05-30',
      merchant: 'Anchor',
    });

    await expect(
      db.delete(chartOfAccounts).where(eq(chartOfAccounts.id, suppliesAccountId)),
    ).rejects.toThrow();
    await expect(
      db.delete(chartOfAccounts).where(eq(chartOfAccounts.id, cashAccountId)),
    ).rejects.toThrow();
  });

  it('blocks delete of a contact referenced by an expense (RESTRICT)', async () => {
    const db = getTestDb();
    const { accountId, companyId, cashAccountId, suppliesAccountId } = await seedTenant();
    const contactId = uuidv7();
    await db
      .insert(contacts)
      .values({ id: contactId, accountId, companyId, name: 'Wile E. Coyote' });
    await db.insert(expenses).values({
      id: uuidv7(),
      accountId,
      companyId,
      customerContactId: contactId,
      categoryAccountId: suppliesAccountId,
      paymentAccountId: cashAccountId,
      amount: '10.00',
      expenseDate: '2026-05-30',
      merchant: 'For Wile',
    });

    await expect(db.delete(contacts).where(eq(contacts.id, contactId))).rejects.toThrow();
  });

  it('allows nullable customer_contact_id (MVP does not expose it)', async () => {
    const db = getTestDb();
    const { accountId, companyId, cashAccountId, suppliesAccountId } = await seedTenant();
    const expenseId = uuidv7();

    await db.insert(expenses).values({
      id: expenseId,
      accountId,
      companyId,
      categoryAccountId: suppliesAccountId,
      paymentAccountId: cashAccountId,
      amount: '10.00',
      expenseDate: '2026-05-30',
      merchant: 'No customer',
    });

    const [row] = await db.select().from(expenses).where(eq(expenses.id, expenseId));
    expect(row?.customerContactId).toBeNull();
  });

  it('cascades delete from accounts → expenses', async () => {
    const db = getTestDb();
    const { accountId, companyId, cashAccountId, suppliesAccountId } = await seedTenant();
    const expenseId = uuidv7();
    await db.insert(expenses).values({
      id: expenseId,
      accountId,
      companyId,
      categoryAccountId: suppliesAccountId,
      paymentAccountId: cashAccountId,
      amount: '10.00',
      expenseDate: '2026-05-30',
      merchant: 'Cascade Target',
    });

    await db.delete(accounts).where(eq(accounts.id, accountId));

    const remaining = await db.select().from(expenses).where(eq(expenses.id, expenseId));
    expect(remaining).toEqual([]);
  });

  it('cascades delete from companies → expenses', async () => {
    const db = getTestDb();
    const { accountId, companyId, cashAccountId, suppliesAccountId } = await seedTenant();
    const expenseId = uuidv7();
    await db.insert(expenses).values({
      id: expenseId,
      accountId,
      companyId,
      categoryAccountId: suppliesAccountId,
      paymentAccountId: cashAccountId,
      amount: '10.00',
      expenseDate: '2026-05-30',
      merchant: 'Cascade Target',
    });

    await db.delete(companies).where(eq(companies.id, companyId));

    const remaining = await db.select().from(expenses).where(eq(expenses.id, expenseId));
    expect(remaining).toEqual([]);
  });

  it('stores jsonb extraction_payload and reads it back as object', async () => {
    const db = getTestDb();
    const { accountId, companyId, cashAccountId, suppliesAccountId } = await seedTenant();
    const expenseId = uuidv7();

    await db.insert(expenses).values({
      id: expenseId,
      accountId,
      companyId,
      categoryAccountId: suppliesAccountId,
      paymentAccountId: cashAccountId,
      amount: '42.50',
      expenseDate: '2026-05-30',
      merchant: 'Home Depot',
      extractionStatus: 'succeeded',
      extractionPayload: {
        merchant: 'Home Depot',
        total: '42.50',
        suggestedCategoryCode: '7000',
      },
    });

    const [row] = await db.select().from(expenses).where(eq(expenses.id, expenseId));
    expect(row?.extractionStatus).toBe('succeeded');
    expect(row?.extractionPayload).toEqual({
      merchant: 'Home Depot',
      total: '42.50',
      suggestedCategoryCode: '7000',
    });
  });
});

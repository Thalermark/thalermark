import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, resetDb } from '../../tests/db-test-helper.js';
import { seedChartOfAccounts } from '../seed/coa.js';
import { accounts } from './accounts.js';
import { chartOfAccounts } from './chart_of_accounts.js';
import { companies } from './companies.js';
import { contacts } from './contacts.js';
import { expenseAllocations } from './expense_allocations.js';
import { expenses } from './expenses.js';
import { invoices } from './invoices.js';

async function seedTenant() {
  const db = getTestDb();
  const accountId = uuidv7();
  const companyId = uuidv7();
  const contactId = uuidv7();
  await db.insert(accounts).values({ id: accountId, name: 'Acme' });
  await db.insert(companies).values({ id: companyId, accountId, name: 'Acme Co' });
  await db.insert(contacts).values({ id: contactId, accountId, companyId, name: 'Smith' });
  await seedChartOfAccounts(db, { accountId, companyId });
  const coa = await db
    .select()
    .from(chartOfAccounts)
    .where(eq(chartOfAccounts.companyId, companyId));
  const cash = coa.find((r) => r.code === '1000');
  const supplies = coa.find((r) => r.code === '7000');
  if (!cash || !supplies) throw new Error('COA seed missing expected accounts');
  return {
    accountId,
    companyId,
    contactId,
    cashAccountId: cash.id,
    suppliesAccountId: supplies.id,
  };
}

async function seedExpense(t: Awaited<ReturnType<typeof seedTenant>>, amount = '180.00') {
  const db = getTestDb();
  const id = uuidv7();
  await db.insert(expenses).values({
    id,
    accountId: t.accountId,
    companyId: t.companyId,
    categoryAccountId: t.suppliesAccountId,
    paymentAccountId: t.cashAccountId,
    amount,
    expenseDate: '2026-06-01',
    merchant: 'Nursery',
  });
  return id;
}

async function seedInvoice(t: Awaited<ReturnType<typeof seedTenant>>, number: string) {
  const db = getTestDb();
  const id = uuidv7();
  await db.insert(invoices).values({
    id,
    accountId: t.accountId,
    companyId: t.companyId,
    contactId: t.contactId,
    number,
    status: 'sent',
    issueDate: '2026-06-01',
    dueDate: '2026-07-01',
    currency: 'USD',
    subtotal: '600.00',
    tax: '0.00',
    total: '600.00',
    publicToken: `tok_${id}`,
  });
  return id;
}

describe('expense_allocations', () => {
  beforeEach(resetDb);

  it('splits one expense across several invoices — the seed case', async () => {
    const db = getTestDb();
    const t = await seedTenant();
    const expenseId = await seedExpense(t);
    const a = await seedInvoice(t, 'INV-1');
    const b = await seedInvoice(t, 'INV-2');
    const c = await seedInvoice(t, 'INV-3');

    await db.insert(expenseAllocations).values(
      [a, b, c].map((invoiceId) => ({
        id: uuidv7(),
        accountId: t.accountId,
        companyId: t.companyId,
        expenseId,
        invoiceId,
        share: '0.333333',
      })),
    );

    const rows = await db
      .select()
      .from(expenseAllocations)
      .where(eq(expenseAllocations.expenseId, expenseId));
    expect(rows).toHaveLength(3);
  });

  it('accepts a shared row with a null invoice', async () => {
    const db = getTestDb();
    const t = await seedTenant();
    const expenseId = await seedExpense(t);

    await db.insert(expenseAllocations).values({
      id: uuidv7(),
      accountId: t.accountId,
      companyId: t.companyId,
      expenseId,
      invoiceId: null,
      share: '1',
    });

    const [row] = await db
      .select()
      .from(expenseAllocations)
      .where(eq(expenseAllocations.expenseId, expenseId));
    expect(row?.invoiceId).toBeNull();
    expect(row?.share).toBe('1.000000');
  });

  // Postgres treats NULLs as distinct in a plain unique index, so without the
  // partial unique an expense could collect several "shared" rows and be
  // double-counted in the shared pool.
  it('refuses a second shared row for the same expense', async () => {
    const db = getTestDb();
    const t = await seedTenant();
    const expenseId = await seedExpense(t);
    const shared = () => ({
      id: uuidv7(),
      accountId: t.accountId,
      companyId: t.companyId,
      expenseId,
      invoiceId: null,
      share: '1',
    });

    await db.insert(expenseAllocations).values(shared());
    await expect(db.insert(expenseAllocations).values(shared())).rejects.toThrow();
  });

  it('refuses two rows for the same expense and invoice', async () => {
    const db = getTestDb();
    const t = await seedTenant();
    const expenseId = await seedExpense(t);
    const invoiceId = await seedInvoice(t, 'INV-1');
    const row = () => ({
      id: uuidv7(),
      accountId: t.accountId,
      companyId: t.companyId,
      expenseId,
      invoiceId,
      share: '0.5',
    });

    await db.insert(expenseAllocations).values(row());
    await expect(db.insert(expenseAllocations).values(row())).rejects.toThrow();
  });

  it('refuses a share outside (0, 1]', async () => {
    const db = getTestDb();
    const t = await seedTenant();
    const expenseId = await seedExpense(t);
    const invoiceId = await seedInvoice(t, 'INV-1');
    const withShare = (share: string) => ({
      id: uuidv7(),
      accountId: t.accountId,
      companyId: t.companyId,
      expenseId,
      invoiceId,
      share,
    });

    await expect(db.insert(expenseAllocations).values(withShare('0'))).rejects.toThrow();
    await expect(db.insert(expenseAllocations).values(withShare('1.5'))).rejects.toThrow();
  });

  it('drops allocations when the expense goes, leaving nothing orphaned', async () => {
    const db = getTestDb();
    const t = await seedTenant();
    const expenseId = await seedExpense(t);
    const invoiceId = await seedInvoice(t, 'INV-1');
    await db.insert(expenseAllocations).values({
      id: uuidv7(),
      accountId: t.accountId,
      companyId: t.companyId,
      expenseId,
      invoiceId,
      share: '1',
    });

    await db.delete(expenses).where(eq(expenses.id, expenseId));

    const rows = await db
      .select()
      .from(expenseAllocations)
      .where(eq(expenseAllocations.expenseId, expenseId));
    expect(rows).toHaveLength(0);
  });

  // Cascade, not restrict: a costing tag must never be the reason an invoice
  // can't be deleted. Losing the tag costs only the attribution.
  it('drops allocations when the invoice goes, without blocking the delete', async () => {
    const db = getTestDb();
    const t = await seedTenant();
    const expenseId = await seedExpense(t);
    const invoiceId = await seedInvoice(t, 'INV-1');
    await db.insert(expenseAllocations).values({
      id: uuidv7(),
      accountId: t.accountId,
      companyId: t.companyId,
      expenseId,
      invoiceId,
      share: '1',
    });

    await db.delete(invoices).where(eq(invoices.id, invoiceId));

    const rows = await db
      .select()
      .from(expenseAllocations)
      .where(eq(expenseAllocations.expenseId, expenseId));
    expect(rows).toHaveLength(0);
    // The expense itself is untouched — the tag is not the record.
    const [exp] = await db.select().from(expenses).where(eq(expenses.id, expenseId));
    expect(exp?.amount).toBe('180.00');
  });
});

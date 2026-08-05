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
import { jobs } from './jobs.js';

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

async function seedJob(t: Awaited<ReturnType<typeof seedTenant>>, name = 'The Smith job') {
  const db = getTestDb();
  const id = uuidv7();
  await db.insert(jobs).values({
    id,
    accountId: t.accountId,
    companyId: t.companyId,
    contactId: t.contactId,
    name,
  });
  return id;
}

async function seedInvoice(
  t: Awaited<ReturnType<typeof seedTenant>>,
  number: string,
  jobId: string | null = null,
) {
  const db = getTestDb();
  const id = uuidv7();
  await db.insert(invoices).values({
    id,
    accountId: t.accountId,
    companyId: t.companyId,
    contactId: t.contactId,
    jobId,
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

// Drizzle wraps the driver error, so the message is only ever "Failed query:
// insert into ..." and the constraint name lives on .cause. Asserting the NAME
// rather than a bare toThrow() is what stops these tests passing on an unrelated
// failure — a typo'd column would reject just as happily.
async function violatedConstraint(op: PromiseLike<unknown>): Promise<string | undefined> {
  try {
    await op;
    return undefined;
  } catch (err) {
    return (err as { cause?: { constraint?: string } }).cause?.constraint;
  }
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

  // A row names an invoice OR a job, never both — otherwise the same cost would
  // be counted once at each grain when job margin rolls the two together.
  it('refuses a row that names both an invoice and a job', async () => {
    const db = getTestDb();
    const t = await seedTenant();
    const expenseId = await seedExpense(t);
    const invoiceId = await seedInvoice(t, 'INV-1');
    const jobId = await seedJob(t);

    const violated = await violatedConstraint(
      db.insert(expenseAllocations).values({
        id: uuidv7(),
        accountId: t.accountId,
        companyId: t.companyId,
        expenseId,
        invoiceId,
        jobId,
        share: '1',
      }),
    );
    expect(violated).toBe('expense_allocations_single_grain_check');
  });

  it('accepts a job-grain row', async () => {
    const db = getTestDb();
    const t = await seedTenant();
    const expenseId = await seedExpense(t);
    const jobId = await seedJob(t);

    await db.insert(expenseAllocations).values({
      id: uuidv7(),
      accountId: t.accountId,
      companyId: t.companyId,
      expenseId,
      jobId,
      share: '1',
    });

    const [row] = await db
      .select()
      .from(expenseAllocations)
      .where(eq(expenseAllocations.expenseId, expenseId));
    expect(row?.jobId).toBe(jobId);
    expect(row?.invoiceId).toBeNull();
  });

  it('refuses two rows for the same expense and job', async () => {
    const db = getTestDb();
    const t = await seedTenant();
    const expenseId = await seedExpense(t);
    const jobId = await seedJob(t);
    const row = () => ({
      id: uuidv7(),
      accountId: t.accountId,
      companyId: t.companyId,
      expenseId,
      jobId,
      share: '0.5',
    });

    await db.insert(expenseAllocations).values(row());
    const violated = await violatedConstraint(db.insert(expenseAllocations).values(row()));
    expect(violated).toBe('expense_allocations_expense_job_uq');
  });

  // Shared is now "neither pointer set". Without widening the partial unique to
  // name job_id too, a job-tagged row would sit inside the shared-row guard and
  // block a genuine shared answer on the same expense.
  it('does not mistake a job-grain row for the shared row', async () => {
    const db = getTestDb();
    const t = await seedTenant();
    const expenseId = await seedExpense(t);
    const jobId = await seedJob(t);

    await db.insert(expenseAllocations).values({
      id: uuidv7(),
      accountId: t.accountId,
      companyId: t.companyId,
      expenseId,
      jobId,
      share: '0.5',
    });
    await db.insert(expenseAllocations).values({
      id: uuidv7(),
      accountId: t.accountId,
      companyId: t.companyId,
      expenseId,
      share: '0.5',
    });

    const rows = await db
      .select()
      .from(expenseAllocations)
      .where(eq(expenseAllocations.expenseId, expenseId));
    expect(rows).toHaveLength(2);
  });

  // The hazard flagged when job costing shipped, now unreachable: a job owning
  // several invoices, where deleting one drops tags belonging to the JOB.
  // Job-grain tags hang off job_id, so an invoice delete cannot touch them.
  it('keeps job-grain tags when one of the job’s invoices is deleted', async () => {
    const db = getTestDb();
    const t = await seedTenant();
    const expenseId = await seedExpense(t);
    const jobId = await seedJob(t);
    const invoiceId = await seedInvoice(t, 'INV-1', jobId);
    await db.insert(expenseAllocations).values({
      id: uuidv7(),
      accountId: t.accountId,
      companyId: t.companyId,
      expenseId,
      jobId,
      share: '1',
    });

    await db.delete(invoices).where(eq(invoices.id, invoiceId));

    const rows = await db
      .select()
      .from(expenseAllocations)
      .where(eq(expenseAllocations.expenseId, expenseId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.jobId).toBe(jobId);
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

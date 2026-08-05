import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, resetDb } from '../../tests/db-test-helper.js';
import { accounts } from './accounts.js';
import { companies } from './companies.js';
import { contacts } from './contacts.js';
import { invoices } from './invoices.js';
import { jobs } from './jobs.js';

async function seedTenant() {
  const db = getTestDb();
  const accountId = uuidv7();
  const companyId = uuidv7();
  const contactId = uuidv7();
  await db.insert(accounts).values({ id: accountId, name: 'Acme' });
  await db.insert(companies).values({ id: companyId, accountId, name: 'Acme Co' });
  await db.insert(contacts).values({ id: contactId, accountId, companyId, name: 'Chen' });
  return { accountId, companyId, contactId };
}

async function seedJob(t: Awaited<ReturnType<typeof seedTenant>>, name = 'Tuesdays at the Chens') {
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
  jobId: string | null,
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

describe('jobs', () => {
  beforeEach(resetDb);

  it('defaults to open', async () => {
    const db = getTestDb();
    const t = await seedTenant();
    const jobId = await seedJob(t);

    const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(row?.status).toBe('open');
    expect(row?.startedOn).toBeNull();
  });

  // The case invoice-as-job could not express: one ongoing arrangement billed
  // biweekly, and a deposit plus a final. Both are one job, many invoices.
  it('owns several invoices', async () => {
    const db = getTestDb();
    const t = await seedTenant();
    const jobId = await seedJob(t);
    await seedInvoice(t, 'INV-1', jobId);
    await seedInvoice(t, 'INV-2', jobId);

    const rows = await db.select().from(invoices).where(eq(invoices.jobId, jobId));
    expect(rows).toHaveLength(2);
  });

  // SET NULL, never cascade. Deleting a job must orphan its invoices, never
  // destroy them — an invoice is a financial record and the job is only a label
  // on it.
  it('orphans its invoices when deleted, rather than destroying them', async () => {
    const db = getTestDb();
    const t = await seedTenant();
    const jobId = await seedJob(t);
    const invoiceId = await seedInvoice(t, 'INV-1', jobId);

    await db.delete(jobs).where(eq(jobs.id, jobId));

    const [row] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(row).toBeDefined();
    expect(row?.jobId).toBeNull();
    expect(row?.total).toBe('600.00');
  });

  // Unlike invoices.contact_id, which is RESTRICT. An invoice without a customer
  // is meaningless; a job without one is merely unlabelled, and losing the job
  // would be the worse outcome.
  it('survives its contact being deleted', async () => {
    const db = getTestDb();
    const t = await seedTenant();
    const jobId = await seedJob(t);

    await db.delete(contacts).where(eq(contacts.id, t.contactId));

    const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(row).toBeDefined();
    expect(row?.contactId).toBeNull();
    expect(row?.name).toBe('Tuesdays at the Chens');
  });

  it('goes when its company goes', async () => {
    const db = getTestDb();
    const t = await seedTenant();
    await seedJob(t);

    await db.delete(companies).where(eq(companies.id, t.companyId));

    const rows = await db.select().from(jobs).where(eq(jobs.accountId, t.accountId));
    expect(rows).toHaveLength(0);
  });

  // The additive claim: an invoice that never joins a job is untouched by any of
  // this, which is what lets the model ship without a backfill.
  it('leaves an invoice with no job perfectly valid', async () => {
    const db = getTestDb();
    const t = await seedTenant();
    const invoiceId = await seedInvoice(t, 'INV-1', null);

    const [row] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(row?.jobId).toBeNull();
  });
});

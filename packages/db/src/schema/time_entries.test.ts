import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, resetDb } from '../../tests/db-test-helper.js';
import { accounts } from './accounts.js';
import { companies } from './companies.js';
import { contacts } from './contacts.js';
import { invoices } from './invoices.js';
import { jobs } from './jobs.js';
import { timeEntries } from './time_entries.js';

async function seedTenant() {
  const db = getTestDb();
  const accountId = uuidv7();
  const companyId = uuidv7();
  const contactId = uuidv7();
  const jobId = uuidv7();
  await db.insert(accounts).values({ id: accountId, name: 'Acme' });
  await db.insert(companies).values({ id: companyId, accountId, name: 'Acme Co' });
  await db.insert(contacts).values({ id: contactId, accountId, companyId, name: 'Chen' });
  await db
    .insert(jobs)
    .values({ id: jobId, accountId, companyId, contactId, name: 'Tuesdays at the Chens' });
  return { accountId, companyId, contactId, jobId };
}

async function seedInvoice(t: Awaited<ReturnType<typeof seedTenant>>, number = 'INV-1') {
  const db = getTestDb();
  const id = uuidv7();
  await db.insert(invoices).values({
    id,
    accountId: t.accountId,
    companyId: t.companyId,
    contactId: t.contactId,
    jobId: t.jobId,
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

async function seedEntry(
  t: Awaited<ReturnType<typeof seedTenant>>,
  overrides: Partial<{ minutes: number; billedInvoiceId: string | null; rate: string }> = {},
) {
  const db = getTestDb();
  const id = uuidv7();
  await db.insert(timeEntries).values({
    id,
    accountId: t.accountId,
    companyId: t.companyId,
    jobId: t.jobId,
    entryDate: '2026-06-01',
    minutes: overrides.minutes ?? 195,
    rate: overrides.rate ?? '22.0000',
    billedInvoiceId: overrides.billedInvoiceId ?? null,
    note: 'Evening sitting',
  });
  return id;
}

describe('time_entries', () => {
  beforeEach(resetDb);

  it('stores minutes exactly, with no rounding baked into storage', async () => {
    const db = getTestDb();
    const t = await seedTenant();
    const id = await seedEntry(t, { minutes: 195 });

    const [row] = await db.select().from(timeEntries).where(eq(timeEntries.id, id));
    // 3h15m. Hours are derived at billing time, never stored.
    expect(row?.minutes).toBe(195);
    expect(row?.rate).toBe('22.0000');
  });

  it('starts unbilled', async () => {
    const db = getTestDb();
    const t = await seedTenant();
    const id = await seedEntry(t);

    const [row] = await db.select().from(timeEntries).where(eq(timeEntries.id, id));
    expect(row?.billedInvoiceId).toBeNull();
  });

  // THE property that distinguishes this table from expense_allocations, which
  // cascades. Deleting an invoice must return the hours to unbilled so they can
  // be billed again; cascading would destroy the record that the work ever
  // happened, which is a far worse loss than a dropped attribution.
  it('returns hours to unbilled when the invoice is deleted, rather than destroying them', async () => {
    const db = getTestDb();
    const t = await seedTenant();
    const invoiceId = await seedInvoice(t);
    const entryId = await seedEntry(t, { billedInvoiceId: invoiceId });

    await db.delete(invoices).where(eq(invoices.id, invoiceId));

    const [row] = await db.select().from(timeEntries).where(eq(timeEntries.id, entryId));
    expect(row).toBeDefined();
    expect(row?.billedInvoiceId).toBeNull();
    expect(row?.minutes).toBe(195);
  });

  // Cascade here, unlike the invoice link: hours have no meaning without the job
  // they were worked on, and job_id is NOT NULL precisely so there is never an
  // "unassigned time" state to fall back to.
  it('goes when its job goes', async () => {
    const db = getTestDb();
    const t = await seedTenant();
    await seedEntry(t);

    await db.delete(jobs).where(eq(jobs.id, t.jobId));

    const rows = await db.select().from(timeEntries).where(eq(timeEntries.accountId, t.accountId));
    expect(rows).toHaveLength(0);
  });

  it('accepts an entry with no rate — time logged for margin, with nothing to bill', async () => {
    const db = getTestDb();
    const t = await seedTenant();
    const id = uuidv7();
    await db.insert(timeEntries).values({
      id,
      accountId: t.accountId,
      companyId: t.companyId,
      jobId: t.jobId,
      entryDate: '2026-06-01',
      minutes: 60,
    });

    const [row] = await db.select().from(timeEntries).where(eq(timeEntries.id, id));
    expect(row?.rate).toBeNull();
  });

  it('refuses an entry with no job', async () => {
    const db = getTestDb();
    const t = await seedTenant();

    await expect(
      db.insert(timeEntries).values({
        id: uuidv7(),
        accountId: t.accountId,
        companyId: t.companyId,
        // biome-ignore lint/suspicious/noExplicitAny: asserting the NOT NULL guard
        jobId: null as any,
        entryDate: '2026-06-01',
        minutes: 60,
      }),
    ).rejects.toThrow();
  });
});

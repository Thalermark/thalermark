import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, resetDb } from '../../tests/db-test-helper.js';
import { accounts } from './accounts.js';
import { companies } from './companies.js';
import { contacts } from './contacts.js';
import { estimateLineItems, estimates } from './estimates.js';
import { invoices } from './invoices.js';

async function seedTenant() {
  const db = getTestDb();
  const accountId = uuidv7();
  const companyId = uuidv7();
  const contactId = uuidv7();
  await db.insert(accounts).values({ id: accountId, name: 'Acme' });
  await db.insert(companies).values({ id: companyId, accountId, name: 'Acme Co' });
  await db.insert(contacts).values({ id: contactId, accountId, companyId, name: 'Wile E. Coyote' });
  return { accountId, companyId, contactId };
}

describe('estimates', () => {
  beforeEach(resetDb);

  it('inserts and reads back an estimate with FKs and default status/currency', async () => {
    const db = getTestDb();
    const { accountId, companyId, contactId } = await seedTenant();
    const estimateId = uuidv7();

    await db.insert(estimates).values({
      id: estimateId,
      accountId,
      companyId,
      contactId,
      number: 'EST-001',
      issueDate: '2026-05-23',
      expiresOn: '2026-06-22',
      subtotal: '100.00',
      tax: '8.25',
      total: '108.25',
    });

    const [row] = await db.select().from(estimates).where(eq(estimates.id, estimateId));
    expect(row?.number).toBe('EST-001');
    expect(row?.status).toBe('draft');
    expect(row?.currency).toBe('USD');
    expect(row?.subtotal).toBe('100.00');
    expect(row?.tax).toBe('8.25');
    expect(row?.total).toBe('108.25');
    expect(row?.issueDate).toBe('2026-05-23');
    expect(row?.expiresOn).toBe('2026-06-22');
    expect(row?.notes).toBeNull();
    expect(row?.sentAt).toBeNull();
    expect(row?.acceptedAt).toBeNull();
    expect(row?.declinedAt).toBeNull();
    expect(row?.expiredAt).toBeNull();
    expect(row?.convertedInvoiceId).toBeNull();
    expect(row?.publicToken).toBeNull();
  });

  it('allows expires_on to be null', async () => {
    const db = getTestDb();
    const { accountId, companyId, contactId } = await seedTenant();
    const estimateId = uuidv7();

    await db.insert(estimates).values({
      id: estimateId,
      accountId,
      companyId,
      contactId,
      number: 'EST-NO-EXPIRY',
      issueDate: '2026-05-23',
    });

    const [row] = await db.select().from(estimates).where(eq(estimates.id, estimateId));
    expect(row?.expiresOn).toBeNull();
  });

  it('rejects insert with non-existent contact_id (FK constraint)', async () => {
    const db = getTestDb();
    const { accountId, companyId } = await seedTenant();

    await expect(
      db.insert(estimates).values({
        id: uuidv7(),
        accountId,
        companyId,
        contactId: uuidv7(),
        number: 'EST-X',
        issueDate: '2026-05-23',
      }),
    ).rejects.toThrow();
  });

  it('blocks delete of a contact who has estimates (RESTRICT)', async () => {
    const db = getTestDb();
    const { accountId, companyId, contactId } = await seedTenant();
    await db.insert(estimates).values({
      id: uuidv7(),
      accountId,
      companyId,
      contactId,
      number: 'EST-001',
      issueDate: '2026-05-23',
    });

    await expect(db.delete(contacts).where(eq(contacts.id, contactId))).rejects.toThrow();
  });

  it('enforces (company_id, number) uniqueness', async () => {
    const db = getTestDb();
    const { accountId, companyId, contactId } = await seedTenant();
    await db.insert(estimates).values({
      id: uuidv7(),
      accountId,
      companyId,
      contactId,
      number: 'EST-001',
      issueDate: '2026-05-23',
    });

    await expect(
      db.insert(estimates).values({
        id: uuidv7(),
        accountId,
        companyId,
        contactId,
        number: 'EST-001',
        issueDate: '2026-05-23',
      }),
    ).rejects.toThrow();
  });

  it('allows the same estimate number across different companies', async () => {
    const db = getTestDb();
    const a = await seedTenant();
    const otherCompanyId = uuidv7();
    const otherContactId = uuidv7();
    await db
      .insert(companies)
      .values({ id: otherCompanyId, accountId: a.accountId, name: 'Acme Side Hustle' });
    await db.insert(contacts).values({
      id: otherContactId,
      accountId: a.accountId,
      companyId: otherCompanyId,
      name: 'Same Coyote',
    });

    await db.insert(estimates).values({
      id: uuidv7(),
      accountId: a.accountId,
      companyId: a.companyId,
      contactId: a.contactId,
      number: 'EST-001',
      issueDate: '2026-05-23',
    });

    await expect(
      db.insert(estimates).values({
        id: uuidv7(),
        accountId: a.accountId,
        companyId: otherCompanyId,
        contactId: otherContactId,
        number: 'EST-001',
        issueDate: '2026-05-23',
      }),
    ).resolves.not.toThrow();
  });

  it('allows the same number as an invoice on the same company (separate sequences)', async () => {
    const db = getTestDb();
    const { accountId, companyId, contactId } = await seedTenant();

    await db.insert(invoices).values({
      id: uuidv7(),
      accountId,
      companyId,
      contactId,
      number: '001',
      issueDate: '2026-05-23',
      dueDate: '2026-06-22',
    });

    await expect(
      db.insert(estimates).values({
        id: uuidv7(),
        accountId,
        companyId,
        contactId,
        number: '001',
        issueDate: '2026-05-23',
      }),
    ).resolves.not.toThrow();
  });

  it('sets converted_invoice_id to null when the linked invoice is deleted', async () => {
    const db = getTestDb();
    const { accountId, companyId, contactId } = await seedTenant();
    const invoiceId = uuidv7();
    const estimateId = uuidv7();

    await db.insert(invoices).values({
      id: invoiceId,
      accountId,
      companyId,
      contactId,
      number: 'INV-FROM-EST',
      issueDate: '2026-05-23',
      dueDate: '2026-06-22',
    });
    await db.insert(estimates).values({
      id: estimateId,
      accountId,
      companyId,
      contactId,
      number: 'EST-CONVERTED',
      issueDate: '2026-05-23',
      convertedInvoiceId: invoiceId,
    });

    await db.delete(invoices).where(eq(invoices.id, invoiceId));

    const [row] = await db.select().from(estimates).where(eq(estimates.id, estimateId));
    expect(row?.convertedInvoiceId).toBeNull();
  });

  it('cascades delete from accounts → estimates', async () => {
    const db = getTestDb();
    const { accountId, companyId, contactId } = await seedTenant();
    const estimateId = uuidv7();
    await db.insert(estimates).values({
      id: estimateId,
      accountId,
      companyId,
      contactId,
      number: 'EST-1',
      issueDate: '2026-05-23',
    });

    await db.delete(accounts).where(eq(accounts.id, accountId));

    const remaining = await db.select().from(estimates).where(eq(estimates.id, estimateId));
    expect(remaining).toEqual([]);
  });
});

describe('estimate_line_items', () => {
  beforeEach(resetDb);

  it('inserts and reads back line items linked to an estimate', async () => {
    const db = getTestDb();
    const { accountId, companyId, contactId } = await seedTenant();
    const estimateId = uuidv7();
    const lineId = uuidv7();
    await db.insert(estimates).values({
      id: estimateId,
      accountId,
      companyId,
      contactId,
      number: 'EST-1',
      issueDate: '2026-05-23',
    });
    await db.insert(estimateLineItems).values({
      id: lineId,
      accountId,
      estimateId,
      position: 1,
      description: 'Power washing — front patio (quote)',
      quantity: '2.5',
      unitPrice: '40.00',
      amount: '100.00',
    });

    const [row] = await db.select().from(estimateLineItems).where(eq(estimateLineItems.id, lineId));
    expect(row?.position).toBe(1);
    expect(row?.description).toBe('Power washing — front patio (quote)');
    expect(row?.quantity).toBe('2.5000');
    // unit_price is numeric(15,4) (TMC-134), so it reads back at 4dp.
    expect(row?.unitPrice).toBe('40.0000');
    expect(row?.amount).toBe('100.00');
  });

  it('rejects insert with non-existent estimate_id (FK constraint)', async () => {
    const db = getTestDb();
    const { accountId } = await seedTenant();
    await expect(
      db.insert(estimateLineItems).values({
        id: uuidv7(),
        accountId,
        estimateId: uuidv7(),
        position: 1,
        description: 'Orphan',
        quantity: '1',
        unitPrice: '1.00',
        amount: '1.00',
      }),
    ).rejects.toThrow();
  });

  it('cascades delete from estimates → estimate_line_items', async () => {
    const db = getTestDb();
    const { accountId, companyId, contactId } = await seedTenant();
    const estimateId = uuidv7();
    const lineId = uuidv7();
    await db.insert(estimates).values({
      id: estimateId,
      accountId,
      companyId,
      contactId,
      number: 'EST-1',
      issueDate: '2026-05-23',
    });
    await db.insert(estimateLineItems).values({
      id: lineId,
      accountId,
      estimateId,
      position: 1,
      description: 'Item',
      quantity: '1',
      unitPrice: '1.00',
      amount: '1.00',
    });

    await db.delete(estimates).where(eq(estimates.id, estimateId));

    const remaining = await db
      .select()
      .from(estimateLineItems)
      .where(eq(estimateLineItems.id, lineId));
    expect(remaining).toEqual([]);
  });
});

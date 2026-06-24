import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, resetDb } from '../../tests/db-test-helper.js';
import { accounts } from './accounts.js';
import { companies } from './companies.js';
import { contacts } from './contacts.js';
import { invoiceLineItems, invoices } from './invoices.js';

async function seedTenant() {
  const db = getTestDb();
  const accountId = uuidv7();
  const companyId = uuidv7();
  const contactId = uuidv7();
  await db.insert(accounts).values({ id: accountId, name: 'Acme' });
  await db.insert(companies).values({ id: companyId, accountId, name: 'Acme Co' });
  await db
    .insert(contacts)
    .values({ id: contactId, accountId, companyId, name: 'Wile E. Coyote' });
  return { accountId, companyId, contactId };
}

describe('invoices', () => {
  beforeEach(resetDb);

  it('inserts and reads back an invoice with FKs and default status/currency', async () => {
    const db = getTestDb();
    const { accountId, companyId, contactId } = await seedTenant();
    const invoiceId = uuidv7();

    await db.insert(invoices).values({
      id: invoiceId,
      accountId,
      companyId,
      contactId,
      number: 'INV-001',
      issueDate: '2026-05-23',
      dueDate: '2026-06-22',
      subtotal: '100.00',
      tax: '8.25',
      total: '108.25',
    });

    const [row] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(row?.number).toBe('INV-001');
    expect(row?.status).toBe('draft');
    expect(row?.currency).toBe('USD');
    expect(row?.subtotal).toBe('100.00');
    expect(row?.tax).toBe('8.25');
    expect(row?.total).toBe('108.25');
    expect(row?.issueDate).toBe('2026-05-23');
    expect(row?.dueDate).toBe('2026-06-22');
    expect(row?.notes).toBeNull();
    expect(row?.sentAt).toBeNull();
    expect(row?.paidAt).toBeNull();
    expect(row?.voidedAt).toBeNull();
    expect(row?.publicToken).toBeNull();
  });

  it('rejects insert with non-existent contact_id (FK constraint)', async () => {
    const db = getTestDb();
    const { accountId, companyId } = await seedTenant();

    await expect(
      db.insert(invoices).values({
        id: uuidv7(),
        accountId,
        companyId,
        contactId: uuidv7(),
        number: 'INV-X',
        issueDate: '2026-05-23',
        dueDate: '2026-06-22',
      }),
    ).rejects.toThrow();
  });

  it('blocks delete of a contact who has invoices (RESTRICT)', async () => {
    const db = getTestDb();
    const { accountId, companyId, contactId } = await seedTenant();
    await db.insert(invoices).values({
      id: uuidv7(),
      accountId,
      companyId,
      contactId,
      number: 'INV-001',
      issueDate: '2026-05-23',
      dueDate: '2026-06-22',
    });

    await expect(db.delete(contacts).where(eq(contacts.id, contactId))).rejects.toThrow();
  });

  it('enforces (company_id, number) uniqueness', async () => {
    const db = getTestDb();
    const { accountId, companyId, contactId } = await seedTenant();
    await db.insert(invoices).values({
      id: uuidv7(),
      accountId,
      companyId,
      contactId,
      number: 'INV-001',
      issueDate: '2026-05-23',
      dueDate: '2026-06-22',
    });

    await expect(
      db.insert(invoices).values({
        id: uuidv7(),
        accountId,
        companyId,
        contactId,
        number: 'INV-001',
        issueDate: '2026-05-23',
        dueDate: '2026-06-22',
      }),
    ).rejects.toThrow();
  });

  it('allows the same invoice number across different companies', async () => {
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

    await db.insert(invoices).values({
      id: uuidv7(),
      accountId: a.accountId,
      companyId: a.companyId,
      contactId: a.contactId,
      number: 'INV-001',
      issueDate: '2026-05-23',
      dueDate: '2026-06-22',
    });

    await expect(
      db.insert(invoices).values({
        id: uuidv7(),
        accountId: a.accountId,
        companyId: otherCompanyId,
        contactId: otherContactId,
        number: 'INV-001',
        issueDate: '2026-05-23',
        dueDate: '2026-06-22',
      }),
    ).resolves.not.toThrow();
  });

  it('cascades delete from accounts → invoices', async () => {
    const db = getTestDb();
    const { accountId, companyId, contactId } = await seedTenant();
    const invoiceId = uuidv7();
    await db.insert(invoices).values({
      id: invoiceId,
      accountId,
      companyId,
      contactId,
      number: 'INV-1',
      issueDate: '2026-05-23',
      dueDate: '2026-06-22',
    });

    await db.delete(accounts).where(eq(accounts.id, accountId));

    const remaining = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(remaining).toEqual([]);
  });
});

describe('invoice_line_items', () => {
  beforeEach(resetDb);

  it('inserts and reads back line items linked to an invoice', async () => {
    const db = getTestDb();
    const { accountId, companyId, contactId } = await seedTenant();
    const invoiceId = uuidv7();
    const lineId = uuidv7();
    await db.insert(invoices).values({
      id: invoiceId,
      accountId,
      companyId,
      contactId,
      number: 'INV-1',
      issueDate: '2026-05-23',
      dueDate: '2026-06-22',
    });
    await db.insert(invoiceLineItems).values({
      id: lineId,
      accountId,
      invoiceId,
      position: 1,
      description: 'Power washing — front patio',
      quantity: '2.5',
      unitPrice: '40.00',
      amount: '100.00',
    });

    const [row] = await db.select().from(invoiceLineItems).where(eq(invoiceLineItems.id, lineId));
    expect(row?.position).toBe(1);
    expect(row?.description).toBe('Power washing — front patio');
    expect(row?.quantity).toBe('2.5000');
    expect(row?.unitPrice).toBe('40.00');
    expect(row?.amount).toBe('100.00');
  });

  it('rejects insert with non-existent invoice_id (FK constraint)', async () => {
    const db = getTestDb();
    const { accountId } = await seedTenant();
    await expect(
      db.insert(invoiceLineItems).values({
        id: uuidv7(),
        accountId,
        invoiceId: uuidv7(),
        position: 1,
        description: 'Orphan',
        quantity: '1',
        unitPrice: '1.00',
        amount: '1.00',
      }),
    ).rejects.toThrow();
  });

  it('cascades delete from invoices → invoice_line_items', async () => {
    const db = getTestDb();
    const { accountId, companyId, contactId } = await seedTenant();
    const invoiceId = uuidv7();
    const lineId = uuidv7();
    await db.insert(invoices).values({
      id: invoiceId,
      accountId,
      companyId,
      contactId,
      number: 'INV-1',
      issueDate: '2026-05-23',
      dueDate: '2026-06-22',
    });
    await db.insert(invoiceLineItems).values({
      id: lineId,
      accountId,
      invoiceId,
      position: 1,
      description: 'Item',
      quantity: '1',
      unitPrice: '1.00',
      amount: '1.00',
    });

    await db.delete(invoices).where(eq(invoices.id, invoiceId));

    const remaining = await db
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.id, lineId));
    expect(remaining).toEqual([]);
  });
});

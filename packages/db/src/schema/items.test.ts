import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, resetDb } from '../../tests/db-test-helper.js';
import { accounts } from './accounts.js';
import { companies } from './companies.js';
import { contacts } from './contacts.js';
import { invoiceLineItems, invoices } from './invoices.js';
import { items } from './items.js';

describe('items', () => {
  beforeEach(resetDb);

  it('inserts and reads back an item with defaults', async () => {
    const db = getTestDb();
    const accountId = uuidv7();
    const companyId = uuidv7();
    const itemId = uuidv7();

    await db.insert(accounts).values({ id: accountId, name: 'Acme' });
    await db.insert(companies).values({ id: companyId, accountId, name: 'Acme Co' });
    await db.insert(items).values({
      id: itemId,
      accountId,
      companyId,
      name: 'Lawn mowing',
    });

    const [row] = await db.select().from(items).where(eq(items.id, itemId));
    expect(row?.name).toBe('Lawn mowing');
    expect(row?.description).toBeNull();
    expect(row?.unitPrice).toBe('0.00');
    expect(row?.unitLabel).toBeNull();
    expect(row?.defaultQuantity).toBe('1.0000');
    expect(row?.archivedAt).toBeNull();
    expect(row?.createdAt).toBeInstanceOf(Date);
  });

  it('stores full catalog fields including archived_at', async () => {
    const db = getTestDb();
    const accountId = uuidv7();
    const companyId = uuidv7();
    const itemId = uuidv7();
    const archivedAt = new Date('2026-06-07T12:00:00.000Z');

    await db.insert(accounts).values({ id: accountId, name: 'Acme' });
    await db.insert(companies).values({ id: companyId, accountId, name: 'Acme Co' });
    await db.insert(items).values({
      id: itemId,
      accountId,
      companyId,
      name: 'Hourly labor',
      description: 'General handyman work',
      unitPrice: '65.00',
      unitLabel: 'hour',
      defaultQuantity: '2.5',
      archivedAt,
    });

    const [row] = await db.select().from(items).where(eq(items.id, itemId));
    expect(row?.description).toBe('General handyman work');
    expect(row?.unitPrice).toBe('65.00');
    expect(row?.unitLabel).toBe('hour');
    expect(row?.defaultQuantity).toBe('2.5000');
    expect(row?.archivedAt).toEqual(archivedAt);
  });

  it('allows duplicate names within a company (catalog names repeat)', async () => {
    const db = getTestDb();
    const accountId = uuidv7();
    const companyId = uuidv7();

    await db.insert(accounts).values({ id: accountId, name: 'Acme' });
    await db.insert(companies).values({ id: companyId, accountId, name: 'Acme Co' });
    await db.insert(items).values({ id: uuidv7(), accountId, companyId, name: 'Cleanup' });

    await expect(
      db.insert(items).values({ id: uuidv7(), accountId, companyId, name: 'Cleanup' }),
    ).resolves.not.toThrow();
  });

  it('rejects insert with non-existent account_id (FK constraint)', async () => {
    const db = getTestDb();
    const accountId = uuidv7();
    const companyId = uuidv7();

    await db.insert(accounts).values({ id: accountId, name: 'Acme' });
    await db.insert(companies).values({ id: companyId, accountId, name: 'Acme Co' });

    await expect(
      db.insert(items).values({
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
      db.insert(items).values({
        id: uuidv7(),
        accountId,
        companyId: uuidv7(), // not seeded
        name: 'Orphan',
      }),
    ).rejects.toThrow();
  });

  it('cascades delete from accounts → items', async () => {
    const db = getTestDb();
    const accountId = uuidv7();
    const companyId = uuidv7();
    const itemId = uuidv7();

    await db.insert(accounts).values({ id: accountId, name: 'Acme' });
    await db.insert(companies).values({ id: companyId, accountId, name: 'Acme Co' });
    await db.insert(items).values({ id: itemId, accountId, companyId, name: 'Cascade Target' });

    await db.delete(accounts).where(eq(accounts.id, accountId));

    const remaining = await db.select().from(items).where(eq(items.id, itemId));
    expect(remaining).toEqual([]);
  });

  it('cascades delete from companies → items', async () => {
    const db = getTestDb();
    const accountId = uuidv7();
    const companyId = uuidv7();
    const itemId = uuidv7();

    await db.insert(accounts).values({ id: accountId, name: 'Acme' });
    await db.insert(companies).values({ id: companyId, accountId, name: 'Acme Co' });
    await db.insert(items).values({ id: itemId, accountId, companyId, name: 'Cascade Target' });

    await db.delete(companies).where(eq(companies.id, companyId));

    const remaining = await db.select().from(items).where(eq(items.id, itemId));
    expect(remaining).toEqual([]);
  });

  it('nulls a line item source_item_id when the item is deleted (ON DELETE SET NULL)', async () => {
    // The provenance breadcrumb must survive an item going away without
    // orphaning the line: the snapshot columns stay, source_item_id resets to
    // null. (In production items archive rather than delete, but the FK action
    // is what guarantees the line never dangles.)
    const db = getTestDb();
    const accountId = uuidv7();
    const companyId = uuidv7();
    const contactId = uuidv7();
    const itemId = uuidv7();
    const invoiceId = uuidv7();
    const lineId = uuidv7();

    await db.insert(accounts).values({ id: accountId, name: 'Acme' });
    await db.insert(companies).values({ id: companyId, accountId, name: 'Acme Co' });
    await db.insert(contacts).values({ id: contactId, accountId, companyId, name: 'Coyote' });
    await db.insert(items).values({ id: itemId, accountId, companyId, name: 'Power washing' });
    await db.insert(invoices).values({
      id: invoiceId,
      accountId,
      companyId,
      contactId,
      number: 'INV-1',
      issueDate: '2026-06-07',
      dueDate: '2026-07-07',
    });
    await db.insert(invoiceLineItems).values({
      id: lineId,
      accountId,
      invoiceId,
      position: 1,
      description: 'Power washing — front patio',
      quantity: '1',
      unitPrice: '120.00',
      amount: '120.00',
      sourceItemId: itemId,
    });

    await db.delete(items).where(eq(items.id, itemId));

    const [row] = await db.select().from(invoiceLineItems).where(eq(invoiceLineItems.id, lineId));
    expect(row?.sourceItemId).toBeNull();
    // Snapshot columns are untouched — the line still reads as it was sold.
    expect(row?.description).toBe('Power washing — front patio');
    expect(row?.amount).toBe('120.00');
  });
});

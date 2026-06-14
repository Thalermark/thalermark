import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, resetDb } from '../../tests/db-test-helper.js';
import { accounts } from './accounts.js';
import { companies } from './companies.js';
import { emailTemplates } from './email_templates.js';

describe('email_templates', () => {
  beforeEach(resetDb);

  const seedCompany = async () => {
    const db = getTestDb();
    const accountId = uuidv7();
    const companyId = uuidv7();
    await db.insert(accounts).values({ id: accountId, name: 'Acme' });
    await db.insert(companies).values({ id: companyId, accountId, name: 'Acme Co' });
    return { db, accountId, companyId };
  };

  it('inserts and reads back an override row', async () => {
    const { db, accountId, companyId } = await seedCompany();
    const id = uuidv7();
    await db.insert(emailTemplates).values({
      id,
      accountId,
      companyId,
      type: 'invoice',
      subject: 'Invoice {{invoice_number}}',
      body: 'Hi {{customer_name}},\n\nThanks.',
    });

    const [row] = await db.select().from(emailTemplates).where(eq(emailTemplates.id, id));
    expect(row?.type).toBe('invoice');
    expect(row?.subject).toBe('Invoice {{invoice_number}}');
    expect(row?.body).toContain('{{customer_name}}');
    expect(row?.createdAt).toBeInstanceOf(Date);
  });

  it('enforces one override per (company, type)', async () => {
    const { db, accountId, companyId } = await seedCompany();
    await db.insert(emailTemplates).values({
      id: uuidv7(),
      accountId,
      companyId,
      type: 'invoice',
      subject: 'a',
      body: 'b',
    });
    // Same type, same company → unique violation.
    await expect(
      db.insert(emailTemplates).values({
        id: uuidv7(),
        accountId,
        companyId,
        type: 'invoice',
        subject: 'c',
        body: 'd',
      }),
    ).rejects.toThrow();
    // A different type for the same company is fine.
    await expect(
      db.insert(emailTemplates).values({
        id: uuidv7(),
        accountId,
        companyId,
        type: 'estimate',
        subject: 'c',
        body: 'd',
      }),
    ).resolves.not.toThrow();
  });

  it('rejects a non-existent company_id (FK constraint)', async () => {
    const { db, accountId } = await seedCompany();
    await expect(
      db.insert(emailTemplates).values({
        id: uuidv7(),
        accountId,
        companyId: uuidv7(), // not seeded
        type: 'invoice',
        subject: 'a',
        body: 'b',
      }),
    ).rejects.toThrow();
  });

  it('cascades delete from companies → email_templates', async () => {
    const { db, accountId, companyId } = await seedCompany();
    const id = uuidv7();
    await db
      .insert(emailTemplates)
      .values({ id, accountId, companyId, type: 'statement', subject: 'a', body: 'b' });

    await db.delete(companies).where(eq(companies.id, companyId));

    const remaining = await db.select().from(emailTemplates).where(eq(emailTemplates.id, id));
    expect(remaining).toEqual([]);
  });
});

import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, resetDb } from '../../tests/db-test-helper.js';
import { accounts } from './accounts.js';
import { companies } from './companies.js';
import { customers } from './customers.js';
import { invoiceLineItems, invoices } from './invoices.js';
import { taxPolicies } from './tax_policies.js';

describe('tax_policies', () => {
  beforeEach(resetDb);

  it('inserts and reads back a policy with defaults', async () => {
    const db = getTestDb();
    const accountId = uuidv7();
    const companyId = uuidv7();
    const policyId = uuidv7();

    await db.insert(accounts).values({ id: accountId, name: 'Acme' });
    await db.insert(companies).values({ id: companyId, accountId, name: 'Acme Co' });
    await db.insert(taxPolicies).values({
      id: policyId,
      accountId,
      companyId,
      name: 'General',
    });

    const [row] = await db.select().from(taxPolicies).where(eq(taxPolicies.id, policyId));
    expect(row?.name).toBe('General');
    expect(row?.ratePct).toBe('0.0000');
    expect(row?.isDefault).toBe(false);
    expect(row?.archivedAt).toBeNull();
    expect(row?.createdAt).toBeInstanceOf(Date);
  });

  it('stores full fields including a rate, default flag, and archived_at', async () => {
    const db = getTestDb();
    const accountId = uuidv7();
    const companyId = uuidv7();
    const policyId = uuidv7();
    const archivedAt = new Date('2026-06-14T12:00:00.000Z');

    await db.insert(accounts).values({ id: accountId, name: 'Acme' });
    await db.insert(companies).values({ id: companyId, accountId, name: 'Acme Co' });
    await db.insert(taxPolicies).values({
      id: policyId,
      accountId,
      companyId,
      name: 'Sales Tax',
      ratePct: '8.25',
      isDefault: true,
      archivedAt,
    });

    const [row] = await db.select().from(taxPolicies).where(eq(taxPolicies.id, policyId));
    expect(row?.ratePct).toBe('8.2500');
    expect(row?.isDefault).toBe(true);
    expect(row?.archivedAt).toEqual(archivedAt);
  });

  it('allows duplicate names within a company (policy names repeat)', async () => {
    const db = getTestDb();
    const accountId = uuidv7();
    const companyId = uuidv7();

    await db.insert(accounts).values({ id: accountId, name: 'Acme' });
    await db.insert(companies).values({ id: companyId, accountId, name: 'Acme Co' });
    await db.insert(taxPolicies).values({ id: uuidv7(), accountId, companyId, name: 'General' });

    await expect(
      db.insert(taxPolicies).values({ id: uuidv7(), accountId, companyId, name: 'General' }),
    ).resolves.not.toThrow();
  });

  it('rejects insert with non-existent account_id (FK constraint)', async () => {
    const db = getTestDb();
    const accountId = uuidv7();
    const companyId = uuidv7();

    await db.insert(accounts).values({ id: accountId, name: 'Acme' });
    await db.insert(companies).values({ id: companyId, accountId, name: 'Acme Co' });

    await expect(
      db.insert(taxPolicies).values({
        id: uuidv7(),
        accountId: uuidv7(), // not seeded
        companyId,
        name: 'Orphan',
      }),
    ).rejects.toThrow();
  });

  it('cascades delete from companies → tax_policies', async () => {
    const db = getTestDb();
    const accountId = uuidv7();
    const companyId = uuidv7();
    const policyId = uuidv7();

    await db.insert(accounts).values({ id: accountId, name: 'Acme' });
    await db.insert(companies).values({ id: companyId, accountId, name: 'Acme Co' });
    await db.insert(taxPolicies).values({ id: policyId, accountId, companyId, name: 'General' });

    await db.delete(companies).where(eq(companies.id, companyId));

    const remaining = await db.select().from(taxPolicies).where(eq(taxPolicies.id, policyId));
    expect(remaining).toEqual([]);
  });

  it('nulls a line item tax_policy_id when the policy is deleted, keeping the tax snapshot', async () => {
    // The policy breadcrumb must survive a policy going away without orphaning
    // the line: the snapshot columns (taxable / tax_rate_pct / tax_amount) stay,
    // tax_policy_id resets to null. In production policies archive rather than
    // delete, but the FK action is what guarantees the line never dangles —
    // same contract as source_item_id.
    const db = getTestDb();
    const accountId = uuidv7();
    const companyId = uuidv7();
    const customerId = uuidv7();
    const policyId = uuidv7();
    const invoiceId = uuidv7();
    const lineId = uuidv7();

    await db.insert(accounts).values({ id: accountId, name: 'Acme' });
    await db.insert(companies).values({ id: companyId, accountId, name: 'Acme Co' });
    await db.insert(customers).values({ id: customerId, accountId, companyId, name: 'Coyote' });
    await db.insert(taxPolicies).values({
      id: policyId,
      accountId,
      companyId,
      name: 'General',
      ratePct: '8.25',
    });
    await db.insert(invoices).values({
      id: invoiceId,
      accountId,
      companyId,
      customerId,
      number: 'INV-1',
      issueDate: '2026-06-14',
      dueDate: '2026-07-14',
    });
    await db.insert(invoiceLineItems).values({
      id: lineId,
      accountId,
      invoiceId,
      position: 1,
      description: 'Hard drive replacement — part',
      quantity: '1',
      unitPrice: '120.00',
      amount: '120.00',
      taxable: true,
      taxRatePct: '8.25',
      taxAmount: '9.90',
      taxPolicyId: policyId,
    });

    await db.delete(taxPolicies).where(eq(taxPolicies.id, policyId));

    const [row] = await db.select().from(invoiceLineItems).where(eq(invoiceLineItems.id, lineId));
    expect(row?.taxPolicyId).toBeNull();
    // Snapshot columns untouched — the line still reads as it was taxed.
    expect(row?.taxable).toBe(true);
    expect(row?.taxRatePct).toBe('8.2500');
    expect(row?.taxAmount).toBe('9.90');
  });
});

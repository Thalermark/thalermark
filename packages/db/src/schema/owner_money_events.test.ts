import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, resetDb } from '../../tests/db-test-helper.js';
import { seedChartOfAccounts } from '../seed/coa-sole-prop.js';
import { accounts } from './accounts.js';
import { chartOfAccounts } from './chart_of_accounts.js';
import { companies } from './companies.js';
import { ownerMoneyEvents } from './owner_money_events.js';

async function seedTenant() {
  const db = getTestDb();
  const accountId = uuidv7();
  const companyId = uuidv7();
  await db.insert(accounts).values({ id: accountId, name: 'Acme' });
  await db.insert(companies).values({ id: companyId, accountId, name: 'Acme Co' });
  await seedChartOfAccounts(db, { accountId, companyId });
  return { accountId, companyId };
}

describe('owner_money_events', () => {
  beforeEach(resetDb);

  it("seeds Owner's Equity (3000) + Owner's Draw (3100) — the posting targets", async () => {
    const { companyId } = await seedTenant();
    const db = getTestDb();
    const coa = await db
      .select()
      .from(chartOfAccounts)
      .where(eq(chartOfAccounts.companyId, companyId));
    const equity = coa.find((r) => r.code === '3000');
    const draw = coa.find((r) => r.code === '3100');
    expect(equity).toMatchObject({ accountType: 'equity', normalBalance: 'credit' });
    expect(draw).toMatchObject({ accountType: 'equity', normalBalance: 'debit' });
  });

  it('inserts and reads back an event with sensible defaults', async () => {
    const db = getTestDb();
    const { accountId, companyId } = await seedTenant();
    const id = uuidv7();

    await db.insert(ownerMoneyEvents).values({
      id,
      accountId,
      companyId,
      kind: 'contribution',
      amount: '1500.00',
      occurredOn: '2026-06-01',
    });

    const [row] = await db.select().from(ownerMoneyEvents).where(eq(ownerMoneyEvents.id, id));
    expect(row?.kind).toBe('contribution');
    expect(row?.amount).toBe('1500.00');
    expect(row?.occurredOn).toBe('2026-06-01');
    expect(row?.memo).toBeNull();
    expect(row?.deletedAt).toBeNull();
    expect(row?.createdAt).toBeInstanceOf(Date);
  });

  it('rejects amount <= 0 (CHECK constraint)', async () => {
    const db = getTestDb();
    const { accountId, companyId } = await seedTenant();

    for (const bad of ['0.00', '-5.00']) {
      await expect(
        db.insert(ownerMoneyEvents).values({
          id: uuidv7(),
          accountId,
          companyId,
          kind: 'draw',
          amount: bad,
          occurredOn: '2026-06-01',
        }),
      ).rejects.toThrow();
    }
  });

  it('rejects insert with non-existent company_id (FK)', async () => {
    const db = getTestDb();
    const { accountId } = await seedTenant();

    await expect(
      db.insert(ownerMoneyEvents).values({
        id: uuidv7(),
        accountId,
        companyId: uuidv7(),
        kind: 'contribution',
        amount: '10.00',
        occurredOn: '2026-06-01',
      }),
    ).rejects.toThrow();
  });
});

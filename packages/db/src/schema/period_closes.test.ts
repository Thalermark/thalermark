import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, resetDb } from '../../tests/db-test-helper.js';
import { seedChartOfAccounts } from '../seed/coa.js';
import { accounts } from './accounts.js';
import { companies } from './companies.js';
import { periodCloses } from './period_closes.js';

// period_closes — the year-end close record (TMC-159). Behaviour lives in
// apps/api/tests/period-close.integration.test.ts; this covers the table's own
// guarantees: the one-active-close-per-year index, the soft-delete escape hatch
// that re-opening depends on, and the fiscal-year CHECK.

async function seedTenant() {
  const db = getTestDb();
  const accountId = uuidv7();
  const companyId = uuidv7();
  await db.insert(accounts).values({ id: accountId, name: 'Acme' });
  await db.insert(companies).values({ id: companyId, accountId, name: 'Acme Co' });
  await seedChartOfAccounts(db, { accountId, companyId });
  return { accountId, companyId };
}

function closeRow(accountId: string, companyId: string, fiscalYear: number) {
  return {
    id: uuidv7(),
    accountId,
    companyId,
    fiscalYear,
    closedThrough: new Date(`${fiscalYear + 1}-01-01T00:00:00Z`),
    journalEntryId: uuidv7(),
    netIncome: '700.00',
    equityCode: '3000',
  };
}

describe('period_closes', () => {
  beforeEach(resetDb);

  it('inserts and reads back a close', async () => {
    const db = getTestDb();
    const { accountId, companyId } = await seedTenant();
    const row = closeRow(accountId, companyId, 2025);

    await db.insert(periodCloses).values(row);
    const [read] = await db.select().from(periodCloses).where(eq(periodCloses.id, row.id));

    expect(read).toMatchObject({
      fiscalYear: 2025,
      netIncome: '700.00',
      equityCode: '3000',
      deletedAt: null,
    });
    // fiscal_year is a bigint column (squawk's prefer-bigint-over-int is a CI
    // gate) declared `mode: 'number'`, so it must come back as a plain number
    // rather than a bigint or a string.
    expect(typeof read?.fiscalYear).toBe('number');
  });

  it('allows only one active close per company per year', async () => {
    const db = getTestDb();
    const { accountId, companyId } = await seedTenant();
    await db.insert(periodCloses).values(closeRow(accountId, companyId, 2025));

    await expect(
      db.insert(periodCloses).values(closeRow(accountId, companyId, 2025)),
    ).rejects.toThrow();
  });

  it('frees the year again once the close is soft-deleted', async () => {
    const db = getTestDb();
    const { accountId, companyId } = await seedTenant();
    const first = closeRow(accountId, companyId, 2025);
    await db.insert(periodCloses).values(first);

    // Re-opening a year soft-deletes its row; the partial unique index is over
    // live rows only, so the year can be closed again afterwards.
    await db
      .update(periodCloses)
      .set({ deletedAt: new Date() })
      .where(eq(periodCloses.id, first.id));

    await expect(
      db.insert(periodCloses).values(closeRow(accountId, companyId, 2025)),
    ).resolves.not.toThrow();
  });

  it('lets different years and different companies coexist', async () => {
    const db = getTestDb();
    const { accountId, companyId } = await seedTenant();
    const otherCompanyId = uuidv7();
    await db.insert(companies).values({ id: otherCompanyId, accountId, name: 'Second Co' });

    await db
      .insert(periodCloses)
      .values([
        closeRow(accountId, companyId, 2024),
        closeRow(accountId, companyId, 2025),
        closeRow(accountId, otherCompanyId, 2025),
      ]);

    const rows = await db.select().from(periodCloses).where(eq(periodCloses.accountId, accountId));
    expect(rows).toHaveLength(3);
  });

  it('rejects an implausible fiscal year', async () => {
    const db = getTestDb();
    const { accountId, companyId } = await seedTenant();

    await expect(
      db.insert(periodCloses).values(closeRow(accountId, companyId, 1899)),
    ).rejects.toThrow();
  });

  it('cascades when the company is deleted', async () => {
    const db = getTestDb();
    const { accountId, companyId } = await seedTenant();
    await db.insert(periodCloses).values(closeRow(accountId, companyId, 2025));

    await db.delete(companies).where(eq(companies.id, companyId));
    const rows = await db.select().from(periodCloses).where(eq(periodCloses.companyId, companyId));
    expect(rows).toHaveLength(0);
  });
});

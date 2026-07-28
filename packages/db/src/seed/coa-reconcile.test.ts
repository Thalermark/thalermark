import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, resetDb } from '../../tests/db-test-helper.js';
import { accounts } from '../schema/accounts.js';
import { chartOfAccounts } from '../schema/chart_of_accounts.js';
import { companies } from '../schema/companies.js';
import { journalEntries } from '../schema/journal_entries.js';
import { journalLines } from '../schema/journal_lines.js';
import { chartForBusinessType, reconcileChartOfAccounts, seedChartOfAccounts } from './coa.js';

// Seeding and re-mapping a company's chart against its business type (TMC-124).
// The pure chart shapes are covered in coa.test.ts; this is the DB behaviour.

let accountId: string;
let companyId: string;

async function seedTenant(businessType?: string | null) {
  const db = getTestDb();
  accountId = uuidv7();
  companyId = uuidv7();
  await db.insert(accounts).values({ id: accountId, name: 'Acme' });
  await db
    .insert(companies)
    .values({ id: companyId, accountId, name: 'Acme Co', businessType: businessType ?? null });
  await seedChartOfAccounts(db, { accountId, companyId, businessType });
}

async function coaRows() {
  return getTestDb()
    .select()
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.accountId, accountId), eq(chartOfAccounts.companyId, companyId)));
}

async function coaByCode() {
  return new Map((await coaRows()).map((r) => [r.code, r]));
}

// Posts a balanced two-line entry against two COA accounts, so those accounts
// count as carrying history. The sum-to-zero trigger is deferrable but still
// fires at commit, so the entry has to actually balance.
async function postAgainst(debitCode: string, creditCode: string) {
  const db = getTestDb();
  const byCode = await coaByCode();
  const debit = byCode.get(debitCode);
  const credit = byCode.get(creditCode);
  if (!debit || !credit) throw new Error(`missing ${debitCode}/${creditCode} in the seeded chart`);
  const entryId = uuidv7();
  await db.insert(journalEntries).values({
    id: entryId,
    accountId,
    companyId,
    sourceEntityType: 'manual',
    sourceEntityId: uuidv7(),
    postedAt: new Date(),
  });
  await db.insert(journalLines).values([
    {
      id: uuidv7(),
      accountId,
      journalEntryId: entryId,
      coaAccountId: debit.id,
      side: 'debit',
      amount: '100.00',
    },
    {
      id: uuidv7(),
      accountId,
      journalEntryId: entryId,
      coaAccountId: credit.id,
      side: 'credit',
      amount: '100.00',
    },
  ]);
}

describe('seedChartOfAccounts', () => {
  beforeEach(resetDb);

  it('seeds the chart for the business type it was given', async () => {
    await seedTenant('s_corp');
    const rows = await coaRows();
    expect(rows).toHaveLength(chartForBusinessType('s_corp').length);
    const byCode = await coaByCode();
    expect(byCode.get('3100')?.name).toBe('Shareholder Distributions');
    expect(byCode.get('7450')?.name).toBe('Officer Compensation');
    expect(byCode.get('4000')?.taxMapping).toBe('Form 1120-S, Line 1a');
  });

  // The signup hook seeds before the welcome wizard captures an answer.
  it('seeds the sole-prop chart when no business type is known yet', async () => {
    await seedTenant(null);
    const byCode = await coaByCode();
    expect(byCode.get('3100')?.name).toBe("Owner's Draw");
    expect(byCode.get('4000')?.taxMapping).toBe('Schedule C, Line 1');
  });

  it('is idempotent — a second call no-ops via (company_id, code) unique', async () => {
    await seedTenant('partnership');
    await seedChartOfAccounts(getTestDb(), { accountId, companyId, businessType: 'partnership' });
    expect(await coaRows()).toHaveLength(chartForBusinessType('partnership').length);
  });
});

describe('reconcileChartOfAccounts', () => {
  beforeEach(resetDb);

  // The common path by far: signup seeds a provisional sole-prop chart, the
  // welcome wizard's answer converts it before anything has been posted.
  it('converts a freshly-seeded chart cleanly', async () => {
    await seedTenant(null);
    const result = await reconcileChartOfAccounts(getTestDb(), {
      accountId,
      companyId,
      businessType: 's_corp',
    });

    expect(result.keptName).toEqual([]);
    expect(result.renamed).toEqual(expect.arrayContaining(['3000', '3100']));
    expect(result.added).toEqual(expect.arrayContaining(['2300', '3200', '3400', '7450']));

    const byCode = await coaByCode();
    expect(byCode.get('3000')?.name).toBe('Capital Stock');
    expect(byCode.get('3100')?.name).toBe('Shareholder Distributions');
    expect(byCode.get('3400')?.name).toBe('Retained Earnings');
    // The whole chart, not just the equity block, now points at the new return.
    expect(byCode.get('6000')?.taxMapping).toBe('Form 1120-S, Line 16');
    expect(byCode.get('7000')?.taxMapping).toBe('Form 1120-S, Line 20');
  });

  it('leaves the chart alone when the type resolves to the same one', async () => {
    await seedTenant('sole_prop');
    const result = await reconcileChartOfAccounts(getTestDb(), {
      accountId,
      companyId,
      businessType: 'llc_single_member',
    });
    expect(result).toEqual({ added: [], renamed: [], keptName: [], deactivated: [] });
  });

  // The promise: money never moves. An account carrying history keeps the label
  // that history was recorded under, and the entries themselves are untouched.
  it('keeps the name of an account that already carries postings', async () => {
    await seedTenant('sole_prop');
    await postAgainst('3100', '1000'); // owner took a draw

    const result = await reconcileChartOfAccounts(getTestDb(), {
      accountId,
      companyId,
      businessType: 'c_corp',
    });

    expect(result.keptName).toContain('3100');
    expect(result.renamed).not.toContain('3100');
    const byCode = await coaByCode();
    expect(byCode.get('3100')?.name).toBe("Owner's Draw");
    // Nothing stopped the accounts with no history from converting.
    expect(byCode.get('3000')?.name).toBe('Capital Stock');
    expect(result.renamed).toContain('3000');
  });

  // tax_mapping points at a line on this year's return — it isn't a record of
  // anything historical, so it follows the entity even on a posted account.
  it('re-maps the tax line even on an account it declined to rename', async () => {
    await seedTenant('sole_prop');
    await postAgainst('6000', '1000'); // paid for advertising

    await reconcileChartOfAccounts(getTestDb(), {
      accountId,
      companyId,
      businessType: 'c_corp',
    });

    const byCode = await coaByCode();
    expect(byCode.get('6000')?.name).toBe('Advertising'); // same on both charts
    expect(byCode.get('6000')?.taxMapping).toBe('Form 1120, Line 22');
  });

  it('leaves every journal entry untouched', async () => {
    await seedTenant('sole_prop');
    await postAgainst('3100', '1000');
    const before = await getTestDb()
      .select()
      .from(journalLines)
      .where(eq(journalLines.accountId, accountId));

    await reconcileChartOfAccounts(getTestDb(), {
      accountId,
      companyId,
      businessType: 's_corp',
    });

    const after = await getTestDb()
      .select()
      .from(journalLines)
      .where(eq(journalLines.accountId, accountId));
    expect(after).toEqual(before);
  });

  // Switching away from an entity leaves accounts the new one has no use for.
  // They're switched off (dropping out of the account pickers), never deleted —
  // journal lines FK against them with RESTRICT.
  it('deactivates an unposted account the new entity does not use', async () => {
    await seedTenant('c_corp');
    const result = await reconcileChartOfAccounts(getTestDb(), {
      accountId,
      companyId,
      businessType: 'sole_prop',
    });

    expect(result.deactivated).toEqual(expect.arrayContaining(['2400', '7800', '7450']));
    const byCode = await coaByCode();
    expect(byCode.get('7800')?.isActive).toBe(false);
    // Still there — deactivated, not deleted.
    expect(byCode.get('7800')).toBeDefined();
  });

  it('keeps an account active when it has history, even off-chart', async () => {
    await seedTenant('c_corp');
    await postAgainst('7800', '2400'); // accrued the corporation's income tax

    const result = await reconcileChartOfAccounts(getTestDb(), {
      accountId,
      companyId,
      businessType: 'sole_prop',
    });

    expect(result.deactivated).not.toContain('7800');
    expect((await coaByCode()).get('7800')?.isActive).toBe(true);
  });

  // An account the new entity has no line for must not keep pointing at the old
  // one, or a sole proprietor's spending prints "Form 1120, Line 31" beside it.
  // Null instead — the tax worksheet has a visible unmapped bucket, so the money
  // still shows up, just not filed under a line that isn't on their return.
  it('clears the tax mapping of an account that leaves the chart', async () => {
    await seedTenant('c_corp');
    await postAgainst('7800', '2400');
    expect((await coaByCode()).get('7800')?.taxMapping).toBe('Form 1120, Line 31');

    await reconcileChartOfAccounts(getTestDb(), {
      accountId,
      companyId,
      businessType: 'sole_prop',
    });

    const byCode = await coaByCode();
    // Kept (it has history) but no longer claiming a line on a form this
    // business doesn't file.
    expect(byCode.get('7800')?.isActive).toBe(true);
    expect(byCode.get('7800')?.taxMapping).toBeNull();
    // The unposted ones are switched off and cleared too.
    expect(byCode.get('7450')?.isActive).toBe(false);
    expect(byCode.get('7450')?.taxMapping).toBeNull();
  });

  it('reactivates an account that comes back with a later switch', async () => {
    await seedTenant('c_corp');
    await reconcileChartOfAccounts(getTestDb(), {
      accountId,
      companyId,
      businessType: 'sole_prop',
    });
    expect((await coaByCode()).get('7450')?.isActive).toBe(false);

    await reconcileChartOfAccounts(getTestDb(), {
      accountId,
      companyId,
      businessType: 's_corp',
    });
    const byCode = await coaByCode();
    expect(byCode.get('7450')?.isActive).toBe(true);
    expect(byCode.get('7450')?.taxMapping).toBe('Form 1120-S, Line 7');
  });

  it('is idempotent — running it twice changes nothing the second time', async () => {
    await seedTenant('sole_prop');
    await reconcileChartOfAccounts(getTestDb(), {
      accountId,
      companyId,
      businessType: 'partnership',
    });
    const second = await reconcileChartOfAccounts(getTestDb(), {
      accountId,
      companyId,
      businessType: 'partnership',
    });
    expect(second).toEqual({ added: [], renamed: [], keptName: [], deactivated: [] });
  });

  it('ends up with the same chart a fresh seed of that type would produce', async () => {
    await seedTenant('sole_prop');
    await reconcileChartOfAccounts(getTestDb(), {
      accountId,
      companyId,
      businessType: 'partnership',
    });

    const actual = (await coaRows())
      .filter((r) => r.isActive)
      .map((r) => ({
        code: r.code,
        name: r.name,
        accountType: r.accountType,
        normalBalance: r.normalBalance,
        taxMapping: r.taxMapping,
      }))
      .sort((a, b) => a.code.localeCompare(b.code));
    expect(actual).toEqual(chartForBusinessType('partnership').map((a) => ({ ...a })));
  });
});

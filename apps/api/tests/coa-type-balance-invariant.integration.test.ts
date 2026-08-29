import { randomUUID } from 'node:crypto';
import { accounts, chartOfAccounts, companies } from '@thalermark/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, resetDb } from './test-helper.js';

// An account's KIND and its DIRECTION must agree, enforced in the database.
//
// The balance sheet reads both: the sign comes from normal_balance, the bucket
// from account_type. Disagree and the amount lands in the right bucket with the
// wrong sign, so Assets = Liabilities + Equity quietly stops holding — while
// every journal entry still balances and the trial balance still sums to zero,
// because those check the entries rather than the account definitions.
describe('chart_of_accounts type/normal_balance invariant', () => {
  // chart_of_accounts has FKs to both, so the rows have to exist for the insert
  // to reach the CHECK being tested at all.
  let accountId: string;
  let companyId: string;

  beforeEach(async () => {
    await resetDb();
    const db = getTestDb();
    accountId = randomUUID();
    companyId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: 'Invariant Test' });
    await db.insert(companies).values({ id: companyId, accountId, name: 'Invariant Test Co' });
  });

  // drizzle wraps the driver error, so the constraint name lives on `cause`
  // rather than in the top-level message. Asserting on the wrapper would pass
  // for ANY rejected insert, including a foreign-key slip in the fixture, which
  // is exactly the false green this test exists to avoid.
  async function rejectionFrom(work: Promise<unknown>): Promise<string> {
    try {
      await work;
      return '';
    } catch (err) {
      const parts: string[] = [];
      let cur: unknown = err;
      while (cur instanceof Error) {
        parts.push(cur.message);
        cur = (cur as { cause?: unknown }).cause;
      }
      return parts.join(' | ');
    }
  }

  const base = (over: Record<string, unknown>) => ({
    id: randomUUID(),
    accountId,
    companyId,
    code: '9999',
    name: 'Test account',
    ...over,
  });

  it('accepts every correct pairing', async () => {
    const db = getTestDb();
    const ok = [
      { accountType: 'asset', normalBalance: 'debit' },
      { accountType: 'expense', normalBalance: 'debit' },
      { accountType: 'liability', normalBalance: 'credit' },
      { accountType: 'equity', normalBalance: 'credit' },
      { accountType: 'revenue', normalBalance: 'credit' },
    ];
    for (const [i, shape] of ok.entries()) {
      await expect(
        db.insert(chartOfAccounts).values(base({ ...shape, code: `990${i}` }) as never),
      ).resolves.toBeDefined();
    }
  });

  it('refuses a liability that grows by debit', async () => {
    // The realistic one. routes/money-accounts.ts used to map credit_card to
    // liability/credit and everything ELSE to asset/debit, so the next
    // liability-shaped money account would have been filed as an asset without
    // anyone editing that line — money owed counted as money held.
    const db = getTestDb();
    const message = await rejectionFrom(
      db
        .insert(chartOfAccounts)
        .values(base({ accountType: 'liability', normalBalance: 'debit' }) as never),
    );
    expect(message).toMatch(/chart_of_accounts_type_balance_check/);
  });

  it('refuses every other wrong pairing', async () => {
    const db = getTestDb();
    const bad = [
      { accountType: 'asset', normalBalance: 'credit' },
      { accountType: 'expense', normalBalance: 'credit' },
      { accountType: 'equity', normalBalance: 'debit' },
      { accountType: 'revenue', normalBalance: 'debit' },
    ];
    for (const [i, shape] of bad.entries()) {
      const message = await rejectionFrom(
        db.insert(chartOfAccounts).values(base({ ...shape, code: `991${i}` }) as never),
      );
      expect(message, `${shape.accountType}/${shape.normalBalance}`).toMatch(
        /chart_of_accounts_type_balance_check/,
      );
    }
  });

  it('every seeded account satisfies it, across all five business types', async () => {
    // The constraint is only worth having if the seeds already agree with it.
    // This asserts that against whatever the seeds actually produce rather than
    // against a copy of their expected contents.
    const db = getTestDb();
    const rows = await db
      .select({
        code: chartOfAccounts.code,
        accountType: chartOfAccounts.accountType,
        normalBalance: chartOfAccounts.normalBalance,
      })
      .from(chartOfAccounts);
    for (const r of rows) {
      const expected = ['asset', 'expense'].includes(r.accountType) ? 'debit' : 'credit';
      expect(r.normalBalance, `${r.code} (${r.accountType})`).toBe(expected);
    }
  });
});

import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, describe, expect, it } from 'vitest';
import { getAppDb, getTestDb, resetDb } from '../tests/db-test-helper.js';
import { withAccountContext } from './client.js';
import { accounts } from './schema/accounts.js';
import { chartOfAccounts } from './schema/chart_of_accounts.js';
import { companies } from './schema/companies.js';
import { journalEntries } from './schema/journal_entries.js';
import { journalLines } from './schema/journal_lines.js';
import { SOLE_PROP_COA, seedChartOfAccounts } from './seed/coa-sole-prop.js';

// Slice L1 — ledger foundation. Covers tenant isolation on the three new
// tables, append-only enforcement on journal_entries / journal_lines, the
// deferrable balance trigger, and the COA seeder shape.
//
// Tests connect as thalermark_app (getAppDb) so RLS policies actually
// fire; seeding through getTestDb (superuser, BYPASSRLS) so the test
// fixture itself isn't subject to policy.

let accountAId: string;
let accountBId: string;
let companyAId: string;
let companyBId: string;
let cashAccountAId: string;
let arAccountAId: string;

async function seedTwoTenants() {
  const db = getTestDb();
  accountAId = uuidv7();
  accountBId = uuidv7();
  companyAId = uuidv7();
  companyBId = uuidv7();
  cashAccountAId = uuidv7();
  arAccountAId = uuidv7();

  await db.insert(accounts).values([
    { id: accountAId, name: 'Account A' },
    { id: accountBId, name: 'Account B' },
  ]);
  await db.insert(companies).values([
    { id: companyAId, accountId: accountAId, name: 'A Co' },
    { id: companyBId, accountId: accountBId, name: 'B Co' },
  ]);
  await db.insert(chartOfAccounts).values([
    {
      id: cashAccountAId,
      accountId: accountAId,
      companyId: companyAId,
      code: '1000',
      name: 'Cash',
      accountType: 'asset',
      normalBalance: 'debit',
    },
    {
      id: arAccountAId,
      accountId: accountAId,
      companyId: companyAId,
      code: '1200',
      name: 'Accounts Receivable',
      accountType: 'asset',
      normalBalance: 'debit',
    },
  ]);
}

// ---------- chart_of_accounts RLS ----------

describe('RLS — chart_of_accounts tenant isolation', () => {
  beforeEach(async () => {
    await resetDb();
    await seedTwoTenants();
  });

  it('sees only its own account COA when context is set', async () => {
    const seen = await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      return tx.select().from(chartOfAccounts);
    });
    expect(seen.map((r) => r.accountId)).toEqual([accountAId, accountAId]);
  });

  it('sees no COA rows when no account context is set', async () => {
    const seen = await getAppDb().select().from(chartOfAccounts);
    expect(seen).toEqual([]);
  });

  it('blocks INSERT with a foreign account_id (WITH CHECK violation)', async () => {
    const smuggledId = uuidv7();
    await expect(
      withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
        await tx.insert(chartOfAccounts).values({
          id: smuggledId,
          accountId: accountBId,
          companyId: companyBId,
          code: '9999',
          name: 'Smuggled',
          accountType: 'asset',
          normalBalance: 'debit',
        });
      }),
    ).rejects.toThrow();
    const found = await getTestDb()
      .select()
      .from(chartOfAccounts)
      .where(eq(chartOfAccounts.id, smuggledId));
    expect(found).toEqual([]);
  });
});

// ---------- journal_entries / journal_lines RLS + append-only ----------

describe('RLS — journal_entries + journal_lines tenant isolation', () => {
  beforeEach(async () => {
    await resetDb();
    await seedTwoTenants();
  });

  it('blocks INSERT with a foreign account_id on journal_entries', async () => {
    const smuggledId = uuidv7();
    await expect(
      withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
        await tx.insert(journalEntries).values({
          id: smuggledId,
          accountId: accountBId,
          companyId: companyBId,
          sourceEntityType: 'invoice',
          sourceEntityId: uuidv7(),
          postedAt: new Date(),
        });
      }),
    ).rejects.toThrow();
  });

  it('sees no journal_entries when no account context is set', async () => {
    const seen = await getAppDb().select().from(journalEntries);
    expect(seen).toEqual([]);
  });
});

describe('RLS — journal_entries + journal_lines are append-only', () => {
  let entryId: string;

  beforeEach(async () => {
    await resetDb();
    await seedTwoTenants();
    entryId = uuidv7();
    const db = getTestDb();
    await db.insert(journalEntries).values({
      id: entryId,
      accountId: accountAId,
      companyId: companyAId,
      sourceEntityType: 'invoice',
      sourceEntityId: uuidv7(),
      postedAt: new Date(),
      memo: 'initial',
    });
    await db.insert(journalLines).values([
      {
        id: uuidv7(),
        accountId: accountAId,
        journalEntryId: entryId,
        coaAccountId: arAccountAId,
        side: 'debit',
        amount: '100.00',
      },
      {
        id: uuidv7(),
        accountId: accountAId,
        journalEntryId: entryId,
        coaAccountId: cashAccountAId,
        side: 'credit',
        amount: '100.00',
      },
    ]);
  });

  it('app role UPDATE on journal_entries is invisible (no policy)', async () => {
    await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      await tx
        .update(journalEntries)
        .set({ memo: 'tampered' })
        .where(eq(journalEntries.id, entryId));
    });
    const row = await getTestDb()
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.id, entryId));
    expect(row[0]?.memo).toBe('initial');
  });

  it('app role DELETE on journal_entries is invisible (no policy)', async () => {
    await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      await tx.delete(journalEntries).where(eq(journalEntries.id, entryId));
    });
    const row = await getTestDb()
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.id, entryId));
    expect(row).toHaveLength(1);
  });

  it('app role UPDATE on journal_lines is invisible', async () => {
    await withAccountContext(getAppDb(), { accountId: accountAId }, async (tx) => {
      await tx.update(journalLines).set({ amount: '999.00' }).where(eq(journalLines.side, 'debit'));
    });
    const rows = await getTestDb()
      .select()
      .from(journalLines)
      .where(eq(journalLines.journalEntryId, entryId));
    expect(rows.every((r) => r.amount === '100.00')).toBe(true);
  });
});

// ---------- balance trigger ----------
//
// Drizzle wraps a postgres trigger-raised exception inside a generic
// "Failed query: commit" error envelope and doesn't preserve the
// underlying message on the top-level Error. We assert that the tx
// rejects (which only happens when the deferred constraint trigger
// fires) — the balanced-commit tests above prove the trigger doesn't
// reject spuriously, so the contrast is the meaningful signal.

describe('balance trigger — sum-to-zero and min-2-lines', () => {
  beforeEach(async () => {
    await resetDb();
    await seedTwoTenants();
  });

  it('balanced entry (debit 100 / credit 100) commits', async () => {
    const entryId = uuidv7();
    const db = getTestDb();
    await db.transaction(async (tx) => {
      await tx.insert(journalEntries).values({
        id: entryId,
        accountId: accountAId,
        companyId: companyAId,
        sourceEntityType: 'invoice',
        sourceEntityId: uuidv7(),
        postedAt: new Date(),
      });
      await tx.insert(journalLines).values([
        {
          id: uuidv7(),
          accountId: accountAId,
          journalEntryId: entryId,
          coaAccountId: arAccountAId,
          side: 'debit',
          amount: '100.00',
        },
        {
          id: uuidv7(),
          accountId: accountAId,
          journalEntryId: entryId,
          coaAccountId: cashAccountAId,
          side: 'credit',
          amount: '100.00',
        },
      ]);
    });
    const lines = await db
      .select()
      .from(journalLines)
      .where(eq(journalLines.journalEntryId, entryId));
    expect(lines).toHaveLength(2);
  });

  it('unbalanced entry (debit 100 / credit 50) raises at commit', async () => {
    const entryId = uuidv7();
    const db = getTestDb();
    await expect(
      db.transaction(async (tx) => {
        await tx.insert(journalEntries).values({
          id: entryId,
          accountId: accountAId,
          companyId: companyAId,
          sourceEntityType: 'invoice',
          sourceEntityId: uuidv7(),
          postedAt: new Date(),
        });
        await tx.insert(journalLines).values([
          {
            id: uuidv7(),
            accountId: accountAId,
            journalEntryId: entryId,
            coaAccountId: arAccountAId,
            side: 'debit',
            amount: '100.00',
          },
          {
            id: uuidv7(),
            accountId: accountAId,
            journalEntryId: entryId,
            coaAccountId: cashAccountAId,
            side: 'credit',
            amount: '50.00',
          },
        ]);
      }),
    ).rejects.toThrow();
  });

  it('single-line entry raises at commit (min-2-lines)', async () => {
    const entryId = uuidv7();
    const db = getTestDb();
    await expect(
      db.transaction(async (tx) => {
        await tx.insert(journalEntries).values({
          id: entryId,
          accountId: accountAId,
          companyId: companyAId,
          sourceEntityType: 'invoice',
          sourceEntityId: uuidv7(),
          postedAt: new Date(),
        });
        await tx.insert(journalLines).values({
          id: uuidv7(),
          accountId: accountAId,
          journalEntryId: entryId,
          coaAccountId: arAccountAId,
          side: 'debit',
          amount: '100.00',
        });
      }),
    ).rejects.toThrow();
  });

  it('zero-line entry raises at commit (header without lines)', async () => {
    const entryId = uuidv7();
    const db = getTestDb();
    // Zero-line state is reached by inserting then deleting the only line
    // in the same tx — the trigger fires on the DELETE and checks at
    // commit. (A bare INSERT of just journal_entries with no lines does
    // NOT fire the constraint trigger today, because the trigger lives on
    // journal_lines. We test the realistic reachable path instead.)
    await expect(
      db.transaction(async (tx) => {
        await tx.insert(journalEntries).values({
          id: entryId,
          accountId: accountAId,
          companyId: companyAId,
          sourceEntityType: 'invoice',
          sourceEntityId: uuidv7(),
          postedAt: new Date(),
        });
        const lineId = uuidv7();
        await tx.insert(journalLines).values([
          {
            id: lineId,
            accountId: accountAId,
            journalEntryId: entryId,
            coaAccountId: arAccountAId,
            side: 'debit',
            amount: '100.00',
          },
          {
            id: uuidv7(),
            accountId: accountAId,
            journalEntryId: entryId,
            coaAccountId: cashAccountAId,
            side: 'credit',
            amount: '100.00',
          },
        ]);
        await tx.delete(journalLines).where(eq(journalLines.journalEntryId, entryId));
      }),
    ).rejects.toThrow();
  });

  it('multi-line balanced entry (3 lines) commits', async () => {
    const entryId = uuidv7();
    const db = getTestDb();
    await db.transaction(async (tx) => {
      await tx.insert(journalEntries).values({
        id: entryId,
        accountId: accountAId,
        companyId: companyAId,
        sourceEntityType: 'invoice',
        sourceEntityId: uuidv7(),
        postedAt: new Date(),
      });
      await tx.insert(journalLines).values([
        {
          id: uuidv7(),
          accountId: accountAId,
          journalEntryId: entryId,
          coaAccountId: arAccountAId,
          side: 'debit',
          amount: '110.00',
        },
        {
          id: uuidv7(),
          accountId: accountAId,
          journalEntryId: entryId,
          coaAccountId: cashAccountAId,
          side: 'credit',
          amount: '100.00',
        },
        {
          id: uuidv7(),
          accountId: accountAId,
          journalEntryId: entryId,
          coaAccountId: cashAccountAId,
          side: 'credit',
          amount: '10.00',
        },
      ]);
    });
    const lines = await db
      .select()
      .from(journalLines)
      .where(eq(journalLines.journalEntryId, entryId));
    expect(lines).toHaveLength(3);
  });
});

// ---------- COA seeder ----------

describe('seedChartOfAccounts — sole-prop seed', () => {
  beforeEach(async () => {
    await resetDb();
    const db = getTestDb();
    accountAId = uuidv7();
    companyAId = uuidv7();
    await db.insert(accounts).values({ id: accountAId, name: 'Account A' });
    await db.insert(companies).values({ id: companyAId, accountId: accountAId, name: 'A Co' });
  });

  it('seeds the full sole-prop chart on first call', async () => {
    await seedChartOfAccounts(getTestDb(), {
      accountId: accountAId,
      companyId: companyAId,
    });
    const rows = await getTestDb()
      .select()
      .from(chartOfAccounts)
      .where(eq(chartOfAccounts.companyId, companyAId));
    expect(rows).toHaveLength(SOLE_PROP_COA.length);
    const codes = rows.map((r) => r.code).sort();
    expect(codes).toEqual(SOLE_PROP_COA.map((c) => c.code).sort());
  });

  it('is idempotent — second call no-ops via (company_id, code) unique', async () => {
    await seedChartOfAccounts(getTestDb(), {
      accountId: accountAId,
      companyId: companyAId,
    });
    await seedChartOfAccounts(getTestDb(), {
      accountId: accountAId,
      companyId: companyAId,
    });
    const rows = await getTestDb()
      .select()
      .from(chartOfAccounts)
      .where(eq(chartOfAccounts.companyId, companyAId));
    expect(rows).toHaveLength(SOLE_PROP_COA.length);
  });
});

import { describe, expect, it } from 'vitest';
import { buildClosingPlan } from './period-close.js';

// Pure-policy coverage for the year-end closing entry (TMC-159). Integration
// coverage — real Postgres, the deferred sum-to-zero trigger, RLS, the lock, and
// the balance-sheet invariant end to end — lives in
// apps/api/tests/period-close.integration.test.ts.
//
// buildClosingPlan is where the arithmetic actually is: each P&L account is
// zeroed by posting the opposite of its balance, and equity absorbs the net.
// Balances arrive in RAW debit-minus-credit cents (positive = net debit), which
// is what closingBalances reads off the ledger.

const EQUITY = { coaAccountId: 'equity-id', code: '3000' };

// Revenue carries a credit balance, so its raw figure is negative; expenses and
// withdrawals carry debit balances, so theirs are positive.
const revenue = (cents: number) => ({
  coaAccountId: 'rev-id',
  code: '4000',
  accountType: 'revenue',
  raw: -cents,
});
const expense = (cents: number) => ({
  coaAccountId: 'exp-id',
  code: '6200',
  accountType: 'expense',
  raw: cents,
});
const draw = (cents: number) => ({
  coaAccountId: 'draw-id',
  code: '3100',
  accountType: 'equity',
  raw: cents,
});

// A posting is valid iff debits equal credits. Summed in integer CENTS, not
// dollars: adding decimal strings as floats drifts (33.37 + 66.96 lands on
// 100.32999999999998), which would make an exact assertion fail on arithmetic
// the production code got right.
function sides(lines: { side: 'debit' | 'credit'; amount: string }[]) {
  const sum = (side: 'debit' | 'credit') =>
    lines
      .filter((l) => l.side === side)
      .reduce((s, l) => s + Math.round(Number(l.amount) * 100), 0);
  return { debit: sum('debit'), credit: sum('credit') };
}

function lineFor(
  plan: { lines: { coaAccountId: string; side: string; amount: string }[] },
  coaAccountId: string,
) {
  return plan.lines.find((l) => l.coaAccountId === coaAccountId);
}

describe('buildClosingPlan — the year-end closing entry', () => {
  it('zeroes revenue and expenses and credits the profit to equity', () => {
    const plan = buildClosingPlan([revenue(100_000), expense(30_000)], EQUITY);
    if (!plan) throw new Error('expected a plan');

    // Each account is closed by the opposite of its balance: revenue carries a
    // credit balance so it's debited, expenses the other way round.
    expect(lineFor(plan, 'rev-id')).toMatchObject({ side: 'debit', amount: '1000.00' });
    expect(lineFor(plan, 'exp-id')).toMatchObject({ side: 'credit', amount: '300.00' });
    // A profit increases equity, so the plug is a credit.
    expect(lineFor(plan, 'equity-id')).toMatchObject({ side: 'credit', amount: '700.00' });

    expect(plan.netIncome).toBe('700.00');
    expect(plan.withdrawals).toBe('0.00');
    expect(plan.equityCode).toBe('3000');
    expect(sides(plan.lines)).toEqual({ debit: 100_000, credit: 100_000 });
  });

  it('debits equity for a loss year', () => {
    const plan = buildClosingPlan([revenue(20_000), expense(50_000)], EQUITY);
    if (!plan) throw new Error('expected a plan');

    expect(lineFor(plan, 'equity-id')).toMatchObject({ side: 'debit', amount: '300.00' });
    expect(plan.netIncome).toBe('-300.00');
    const s = sides(plan.lines);
    expect(s.debit).toBe(s.credit);
  });

  it('rolls withdrawals into equity without counting them as profit', () => {
    const plan = buildClosingPlan([revenue(100_000), expense(30_000), draw(20_000)], EQUITY);
    if (!plan) throw new Error('expected a plan');

    // 3100 carries a debit balance, so it closes with a credit — and the plug
    // shrinks to 700 profit − 200 taken out.
    expect(lineFor(plan, 'draw-id')).toMatchObject({ side: 'credit', amount: '200.00' });
    expect(lineFor(plan, 'equity-id')).toMatchObject({ side: 'credit', amount: '500.00' });

    // Money the owner took out moves equity but is not a cost of doing
    // business — it must not distort the reported figure.
    expect(plan.netIncome).toBe('700.00');
    expect(plan.withdrawals).toBe('200.00');
    expect(sides(plan.lines)).toEqual({ debit: 100_000, credit: 100_000 });
  });

  it('needs no equity plug for a break-even year', () => {
    const plan = buildClosingPlan([revenue(40_000), expense(40_000)], EQUITY);
    if (!plan) throw new Error('expected a plan');

    // The two flipped lines already balance each other, so equity is untouched.
    expect(lineFor(plan, 'equity-id')).toBeUndefined();
    expect(plan.lines).toHaveLength(2);
    expect(plan.netIncome).toBe('0.00');
    expect(sides(plan.lines)).toEqual({ debit: 40_000, credit: 40_000 });
  });

  it('routes withdrawals to equity even with no trading at all', () => {
    // An owner who took money out of a business that earned nothing still needs
    // 3100 cleared, and equity absorbs it as a debit.
    const plan = buildClosingPlan([draw(15_000)], EQUITY);
    if (!plan) throw new Error('expected a plan');

    expect(lineFor(plan, 'draw-id')).toMatchObject({ side: 'credit', amount: '150.00' });
    expect(lineFor(plan, 'equity-id')).toMatchObject({ side: 'debit', amount: '150.00' });
    expect(plan.netIncome).toBe('0.00');
    expect(plan.withdrawals).toBe('150.00');
  });

  it('returns null when there is nothing to close', () => {
    // No balances at all — an untraded year has no balanced entry to post, and
    // the route turns this into `nothing_to_close` rather than an empty entry.
    expect(buildClosingPlan([], EQUITY)).toBeNull();
  });

  it('carries the corp equity code through to the recorded close', () => {
    const plan = buildClosingPlan([revenue(50_000)], {
      coaAccountId: 're-id',
      code: '3400',
    });
    if (!plan) throw new Error('expected a plan');

    // The code is snapshotted on the period_closes row so history still reads
    // correctly after a business-type change re-maps the chart.
    expect(plan.equityCode).toBe('3400');
    expect(lineFor(plan, 're-id')).toMatchObject({ side: 'credit', amount: '500.00' });
  });

  it('stays exact at the cent, with no floating-point drift', () => {
    // Thirds of a dollar are the classic place naive float math leaks a cent.
    const plan = buildClosingPlan([revenue(10_033), expense(3_337)], EQUITY);
    if (!plan) throw new Error('expected a plan');

    expect(plan.netIncome).toBe('66.96');
    expect(lineFor(plan, 'equity-id')).toMatchObject({ side: 'credit', amount: '66.96' });
    expect(sides(plan.lines)).toEqual({ debit: 10_033, credit: 10_033 });
  });
});

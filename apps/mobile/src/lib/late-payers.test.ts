import { describe, expect, it } from 'vitest';
import { type LatePayer, chaseLine } from './late-payers';

// A stand-in for the screen's money formatter, so these assert the SENTENCE
// rules rather than currency rendering.
const money = (amount: string) => `$${amount}`;

const payer = (over: Partial<LatePayer> = {}): LatePayer => ({
  contactId: 'c1',
  name: 'Bob',
  outstanding: '1200.00',
  maxDaysPastDue: 14,
  paidCount: 5,
  lateCount: 3,
  ...over,
});

describe('chaseLine', () => {
  it('leads with what is outstanding, which is always known', () => {
    expect(chaseLine(payer({ maxDaysPastDue: null, paidCount: 0, lateCount: 0 }), money)).toBe(
      '$1200.00 outstanding',
    );
  });

  it('assembles all three parts when the data supports all three', () => {
    expect(chaseLine(payer(), money)).toBe(
      '$1200.00 outstanding · 14 days past due · paid late 3 of 5 times',
    );
  });

  it('omits days past due when nothing is currently overdue', () => {
    // A contact can appear on late HISTORY while owing nothing overdue right
    // now. "0 days past due" would be false, so the part is dropped entirely.
    expect(chaseLine(payer({ maxDaysPastDue: null }), money)).toBe(
      '$1200.00 outstanding · paid late 3 of 5 times',
    );
  });

  it('keeps zero days past due, which is a real answer and not a missing one', () => {
    expect(chaseLine(payer({ maxDaysPastDue: 0 }), money)).toContain('0 days past due');
  });

  it('makes no pattern claim on a single settled invoice', () => {
    // "paid late 1 of 1 times" is one data point wearing a statistic's clothes.
    const line = chaseLine(payer({ paidCount: 1, lateCount: 1 }), money);
    expect(line).not.toContain('paid late');
    expect(line).toBe('$1200.00 outstanding · 14 days past due');
  });

  it('makes no pattern claim with nothing settled at all', () => {
    expect(chaseLine(payer({ paidCount: 0, lateCount: 0 }), money)).not.toContain('paid late');
  });

  it('claims a pattern from two settled invoices, the threshold', () => {
    expect(chaseLine(payer({ paidCount: 2, lateCount: 1 }), money)).toContain(
      'paid late 1 of 2 times',
    );
  });

  it('says nothing about lateness for someone with a clean settled history', () => {
    // Ranked in on outstanding money alone; they have simply never paid late.
    expect(chaseLine(payer({ paidCount: 9, lateCount: 0 }), money)).not.toContain('paid late');
  });

  it('separates parts the same way web does', () => {
    expect(chaseLine(payer(), money).split(' · ')).toHaveLength(3);
  });
});

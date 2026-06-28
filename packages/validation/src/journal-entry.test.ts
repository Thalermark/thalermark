import { describe, expect, it } from 'vitest';
import { manualJournalEntryCreateSchema } from './journal-entry.js';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const ACC_A = '22222222-2222-4222-8222-222222222222';
const ACC_B = '33333333-3333-4333-8333-333333333333';
const ACC_C = '44444444-4444-4444-8444-444444444444';

const base = {
  companyId: COMPANY,
  postedOn: '2026-12-31',
  memo: 'Year-end depreciation per CPA',
};

describe('manualJournalEntryCreateSchema', () => {
  it('accepts a balanced two-line entry', () => {
    const parsed = manualJournalEntryCreateSchema.safeParse({
      ...base,
      lines: [
        { coaAccountId: ACC_A, side: 'debit', amount: '500.00' },
        { coaAccountId: ACC_B, side: 'credit', amount: '500.00' },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a balanced multi-line entry (split across lines)', () => {
    const parsed = manualJournalEntryCreateSchema.safeParse({
      ...base,
      lines: [
        { coaAccountId: ACC_A, side: 'debit', amount: '300.00' },
        { coaAccountId: ACC_C, side: 'debit', amount: '200.00' },
        { coaAccountId: ACC_B, side: 'credit', amount: '500.00' },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unbalanced entry', () => {
    const parsed = manualJournalEntryCreateSchema.safeParse({
      ...base,
      lines: [
        { coaAccountId: ACC_A, side: 'debit', amount: '500.00' },
        { coaAccountId: ACC_B, side: 'credit', amount: '400.00' },
      ],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.message.includes('does not balance'))).toBe(true);
    }
  });

  it('rejects fewer than two lines', () => {
    const parsed = manualJournalEntryCreateSchema.safeParse({
      ...base,
      lines: [{ coaAccountId: ACC_A, side: 'debit', amount: '500.00' }],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a zero-amount line', () => {
    const parsed = manualJournalEntryCreateSchema.safeParse({
      ...base,
      lines: [
        { coaAccountId: ACC_A, side: 'debit', amount: '0.00' },
        { coaAccountId: ACC_B, side: 'credit', amount: '0.00' },
      ],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.message.includes('greater than zero'))).toBe(true);
    }
  });

  it('rejects a missing/blank memo', () => {
    const parsed = manualJournalEntryCreateSchema.safeParse({
      ...base,
      memo: '  ',
      lines: [
        { coaAccountId: ACC_A, side: 'debit', amount: '500.00' },
        { coaAccountId: ACC_B, side: 'credit', amount: '500.00' },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown side', () => {
    const parsed = manualJournalEntryCreateSchema.safeParse({
      ...base,
      lines: [
        { coaAccountId: ACC_A, side: 'increase', amount: '500.00' },
        { coaAccountId: ACC_B, side: 'credit', amount: '500.00' },
      ],
    });
    expect(parsed.success).toBe(false);
  });
});

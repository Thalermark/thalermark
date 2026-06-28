import { describe, expect, it } from 'vitest';
import { openingBalanceUpsertSchema } from './opening-balance.js';

const COMPANY = '11111111-1111-4111-8111-111111111111';

describe('openingBalanceUpsertSchema', () => {
  it('accepts cash only and defaults the other figures to 0', () => {
    const parsed = openingBalanceUpsertSchema.safeParse({
      companyId: COMPANY,
      asOfDate: '2026-01-01',
      cash: '1500.00',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.receivables).toBe('0');
      expect(parsed.data.payables).toBe('0');
    }
  });

  it('accepts all three figures', () => {
    const parsed = openingBalanceUpsertSchema.safeParse({
      companyId: COMPANY,
      asOfDate: '2026-01-01',
      cash: '500.00',
      receivables: '200.00',
      payables: '100.00',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an all-zero (empty) opening balance', () => {
    const parsed = openingBalanceUpsertSchema.safeParse({
      companyId: COMPANY,
      asOfDate: '2026-01-01',
      cash: '0',
      receivables: '0',
      payables: '0',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.message.includes('at least one'))).toBe(true);
    }
  });

  it('rejects a negative amount (moneyString)', () => {
    const parsed = openingBalanceUpsertSchema.safeParse({
      companyId: COMPANY,
      asOfDate: '2026-01-01',
      cash: '-50.00',
    });
    expect(parsed.success).toBe(false);
  });
});

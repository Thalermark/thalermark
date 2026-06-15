import { describe, expect, it } from 'vitest';
import {
  type LedgerLine,
  expensePostingLines,
  invoicePostingLines,
  reverseLedgerLines,
} from './ledger.js';

// Pure-policy coverage for the invoice posting matrix. Integration coverage
// (real Postgres, deferred trigger, RLS) lives in
// apps/api/tests/ledger.integration.test.ts.

// productSubtotal '0.00' = an all-service invoice, so the empty Product Revenue
// (4100) line rides along at 0.00 (postJournalEntry drops it). `mixed` exercises
// the split: 40.00 of the 100.00 subtotal is product.
const taxed = { subtotal: '100.00', productSubtotal: '0.00', tax: '8.25', total: '108.25' };
const untaxed = { subtotal: '100.00', productSubtotal: '0.00', tax: '0.00', total: '100.00' };
const zero = { subtotal: '0.00', productSubtotal: '0.00', tax: '0.00', total: '0.00' };
const mixed = { subtotal: '100.00', productSubtotal: '40.00', tax: '8.25', total: '108.25' };

describe('invoicePostingLines — draft → sent', () => {
  it('posts Dr AR / Cr Service Rev / Cr Product Rev / Cr Sales Tax Payable when taxed', () => {
    expect(invoicePostingLines('draft', 'sent', taxed)).toEqual([
      { code: '1200', side: 'debit', amount: '108.25' },
      { code: '4000', side: 'credit', amount: '100.00' },
      { code: '4100', side: 'credit', amount: '0.00' },
      { code: '2200', side: 'credit', amount: '8.25' },
    ]);
  });

  it('still emits a Sales Tax line at zero — postJournalEntry filters', () => {
    expect(invoicePostingLines('draft', 'sent', untaxed)).toEqual([
      { code: '1200', side: 'debit', amount: '100.00' },
      { code: '4000', side: 'credit', amount: '100.00' },
      { code: '4100', side: 'credit', amount: '0.00' },
      { code: '2200', side: 'credit', amount: '0.00' },
    ]);
  });
});

describe('invoicePostingLines — product/service revenue split', () => {
  it('splits the revenue leg across Service (4000) and Product (4100) on draft → sent', () => {
    expect(invoicePostingLines('draft', 'sent', mixed)).toEqual([
      { code: '1200', side: 'debit', amount: '108.25' },
      { code: '4000', side: 'credit', amount: '60.00' },
      { code: '4100', side: 'credit', amount: '40.00' },
      { code: '2200', side: 'credit', amount: '8.25' },
    ]);
  });

  it('debits both revenue accounts on sent → voided', () => {
    expect(invoicePostingLines('sent', 'voided', mixed)).toEqual([
      { code: '4000', side: 'debit', amount: '60.00' },
      { code: '4100', side: 'debit', amount: '40.00' },
      { code: '2200', side: 'debit', amount: '8.25' },
      { code: '1200', side: 'credit', amount: '108.25' },
    ]);
  });
});

describe('invoicePostingLines — draft → paid', () => {
  it('posts Dr Cash / Cr Service Rev / Cr Product Rev / Cr Sales Tax Payable — skips AR', () => {
    expect(invoicePostingLines('draft', 'paid', taxed)).toEqual([
      { code: '1000', side: 'debit', amount: '108.25' },
      { code: '4000', side: 'credit', amount: '100.00' },
      { code: '4100', side: 'credit', amount: '0.00' },
      { code: '2200', side: 'credit', amount: '8.25' },
    ]);
  });
});

describe('invoicePostingLines — sent → paid', () => {
  it('posts Dr Cash / Cr AR — no revenue movement (already booked at send)', () => {
    expect(invoicePostingLines('sent', 'paid', taxed)).toEqual([
      { code: '1000', side: 'debit', amount: '108.25' },
      { code: '1200', side: 'credit', amount: '108.25' },
    ]);
  });
});

describe('invoicePostingLines — sent → voided', () => {
  it('reverses mark-sent: Dr Service Rev / Dr Product Rev / Dr Sales Tax / Cr AR', () => {
    expect(invoicePostingLines('sent', 'voided', taxed)).toEqual([
      { code: '4000', side: 'debit', amount: '100.00' },
      { code: '4100', side: 'debit', amount: '0.00' },
      { code: '2200', side: 'debit', amount: '8.25' },
      { code: '1200', side: 'credit', amount: '108.25' },
    ]);
  });
});

describe('invoicePostingLines — draft → voided', () => {
  it('returns no lines (nothing was previously booked)', () => {
    expect(invoicePostingLines('draft', 'voided', taxed)).toEqual([]);
  });
});

describe('invoicePostingLines — degenerate zero-amount invoice', () => {
  it('emits zero-amount lines on draft → sent; postJournalEntry will skip', () => {
    const lines = invoicePostingLines('draft', 'sent', zero);
    expect(lines.every((l) => Number(l.amount) === 0)).toBe(true);
  });
});

// Slice 8.9b — expense posting policy. Integration coverage (real Postgres,
// COA resolution, deferred trigger) lands alongside the 8.9c API mutations.

describe('expensePostingLines', () => {
  it('posts Dr <category> / Cr <payment> for the same amount', () => {
    expect(
      expensePostingLines({ categoryCode: '7000', paymentCode: '1000', amount: '25.00' }),
    ).toEqual([
      { code: '7000', side: 'debit', amount: '25.00' },
      { code: '1000', side: 'credit', amount: '25.00' },
    ]);
  });

  it('passes the amount through as the original decimal string', () => {
    const lines = expensePostingLines({
      categoryCode: '6000',
      paymentCode: '1000',
      amount: '99.99',
    });
    expect(lines.every((l) => l.amount === '99.99')).toBe(true);
  });
});

describe('reverseLedgerLines', () => {
  const original: LedgerLine[] = [
    { code: '7000', side: 'debit', amount: '25.00' },
    { code: '1000', side: 'credit', amount: '25.00' },
  ];

  it('flips debit ↔ credit on every line', () => {
    expect(reverseLedgerLines(original)).toEqual([
      { code: '7000', side: 'credit', amount: '25.00' },
      { code: '1000', side: 'debit', amount: '25.00' },
    ]);
  });

  it('preserves codes and amounts unchanged', () => {
    const reversed = reverseLedgerLines(original);
    expect(reversed.map((l) => l.code)).toEqual(['7000', '1000']);
    expect(reversed.map((l) => l.amount)).toEqual(['25.00', '25.00']);
  });

  it('is its own inverse — reverse(reverse(x)) === x', () => {
    expect(reverseLedgerLines(reverseLedgerLines(original))).toEqual(original);
  });
});

describe('expense create + reversal composition', () => {
  it('reverse(create) sums to zero per code — net effect of edit prelude', () => {
    const create = expensePostingLines({
      categoryCode: '7000',
      paymentCode: '1000',
      amount: '25.00',
    });
    const reversal = reverseLedgerLines(create);
    const combined = [...create, ...reversal];
    const byCode = new Map<string, number>();
    for (const l of combined) {
      const signed = l.side === 'debit' ? Number(l.amount) : -Number(l.amount);
      byCode.set(l.code, (byCode.get(l.code) ?? 0) + signed);
    }
    for (const net of byCode.values()) {
      expect(net).toBe(0);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { invoicePostingLines } from './ledger.js';

// Pure-policy coverage for the invoice posting matrix. Integration coverage
// (real Postgres, deferred trigger, RLS) lives in
// apps/api/tests/ledger.integration.test.ts.

const taxed = { subtotal: '100.00', tax: '8.25', total: '108.25' };
const untaxed = { subtotal: '100.00', tax: '0.00', total: '100.00' };
const zero = { subtotal: '0.00', tax: '0.00', total: '0.00' };

describe('invoicePostingLines — draft → sent', () => {
  it('posts Dr AR / Cr Revenue / Cr Sales Tax Payable when taxed', () => {
    expect(invoicePostingLines('draft', 'sent', taxed)).toEqual([
      { code: '1200', side: 'debit', amount: '108.25' },
      { code: '4000', side: 'credit', amount: '100.00' },
      { code: '2200', side: 'credit', amount: '8.25' },
    ]);
  });

  it('still emits a Sales Tax line at zero — postJournalEntry filters', () => {
    expect(invoicePostingLines('draft', 'sent', untaxed)).toEqual([
      { code: '1200', side: 'debit', amount: '100.00' },
      { code: '4000', side: 'credit', amount: '100.00' },
      { code: '2200', side: 'credit', amount: '0.00' },
    ]);
  });
});

describe('invoicePostingLines — draft → paid', () => {
  it('posts Dr Cash / Cr Revenue / Cr Sales Tax Payable — skips AR', () => {
    expect(invoicePostingLines('draft', 'paid', taxed)).toEqual([
      { code: '1000', side: 'debit', amount: '108.25' },
      { code: '4000', side: 'credit', amount: '100.00' },
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
  it('reverses mark-sent: Dr Revenue / Dr Sales Tax / Cr AR', () => {
    expect(invoicePostingLines('sent', 'voided', taxed)).toEqual([
      { code: '4000', side: 'debit', amount: '100.00' },
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

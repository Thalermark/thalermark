import { describe, expect, it } from 'vitest';
import { checkPaymentEligibility, summarizeSettlement } from './invoice-payments.js';
import { invoicePaymentLines } from './ledger.js';

// The pure half of partial payments (TMC-187). The settlement label and the
// eligibility guard are decision tables, so they are tested as decision tables
// — the integration test proves the money moves, this proves the rules.

describe('summarizeSettlement', () => {
  const total = 120_000; // $1,200.00

  it('nothing received reads unpaid and keeps the invoice open', () => {
    expect(summarizeSettlement({ totalCents: total, paidCents: 0 })).toEqual({
      settlement: 'unpaid',
      paid: '0.00',
      outstanding: '1200.00',
      status: 'sent',
    });
  });

  it('a deposit reads partial — the case the whole ticket exists for', () => {
    const s = summarizeSettlement({ totalCents: total, paidCents: 60_000 });
    expect(s.settlement).toBe('partial');
    expect(s.outstanding).toBe('600.00');
    // Still open. A half-paid invoice is not a paid invoice, and every report
    // that reads status depends on this staying 'sent'.
    expect(s.status).toBe('sent');
  });

  it('the final payment settles it exactly', () => {
    const s = summarizeSettlement({ totalCents: total, paidCents: total });
    expect(s.settlement).toBe('paid');
    expect(s.outstanding).toBe('0.00');
    expect(s.status).toBe('paid');
  });

  it('overpayment is recorded, not refused, and still counts as settled', () => {
    const s = summarizeSettlement({ totalCents: total, paidCents: 130_000 });
    expect(s.settlement).toBe('overpaid');
    // Negative outstanding is the honest representation of "we owe them $100".
    expect(s.outstanding).toBe('-100.00');
    expect(s.status).toBe('paid');
  });

  it('a full refund reopens the invoice rather than leaving it paid', () => {
    // $600 in, $600 back out.
    const s = summarizeSettlement({ totalCents: total, paidCents: 0 });
    expect(s.settlement).toBe('unpaid');
    expect(s.status).toBe('sent');
  });

  it('refunding more than was received goes negative without crashing', () => {
    const s = summarizeSettlement({ totalCents: total, paidCents: -5_000 });
    expect(s.settlement).toBe('unpaid');
    expect(s.paid).toBe('-50.00');
    expect(s.status).toBe('sent');
  });

  it('a zero-total invoice is settled by definition, not stuck open', () => {
    // Guards the boundary: outstanding is 0 with nothing received, so the
    // paidCents <= 0 branch must not claim it is unpaid forever.
    const s = summarizeSettlement({ totalCents: 0, paidCents: 0 });
    expect(s.outstanding).toBe('0.00');
  });
});

describe('checkPaymentEligibility', () => {
  it('accepts a receipt against an issued invoice', () => {
    expect(checkPaymentEligibility({ status: 'sent', existingPaymentCount: 0 })).toEqual({
      ok: true,
    });
  });

  it('refuses a draft — there is no receivable to pay down', () => {
    expect(checkPaymentEligibility({ status: 'draft', existingPaymentCount: 0 })).toEqual({
      ok: false,
      reason: 'not_issued',
    });
  });

  it('refuses a voided invoice', () => {
    expect(checkPaymentEligibility({ status: 'voided', existingPaymentCount: 0 })).toEqual({
      ok: false,
      reason: 'voided',
    });
  });

  // The load-bearing one. An invoice settled by the OLD single-shot mark-paid
  // has header stamps and no payment rows, and its cash is already on the
  // books — accepting a payment would post the same money twice. This is what
  // makes the change safe against live data.
  it('refuses a legacy invoice settled without payment rows', () => {
    expect(checkPaymentEligibility({ status: 'paid', existingPaymentCount: 0 })).toEqual({
      ok: false,
      reason: 'settled_without_payments',
    });
  });

  it('allows a correction against an invoice settled THROUGH payment rows', () => {
    // Otherwise the only way to fix a mis-keyed payment would be voiding an
    // invoice that was legitimately paid.
    expect(checkPaymentEligibility({ status: 'paid', existingPaymentCount: 2 })).toEqual({
      ok: true,
    });
  });
});

describe('invoicePaymentLines', () => {
  const sum = (lines: ReturnType<typeof invoicePaymentLines>, side: 'debit' | 'credit') =>
    lines
      .filter((l) => l.side === side)
      .reduce((acc, l) => acc + Math.round(Number(l.amount) * 100), 0);

  it('a plain receipt is Dr Cash / Cr AR and balances', () => {
    const lines = invoicePaymentLines({ amount: '600.00' });
    expect(lines).toEqual([
      { code: '1000', side: 'debit', amount: '600.00' },
      { code: '7950', side: 'debit', amount: '0.00' },
      { code: '1200', side: 'credit', amount: '600.00' },
    ]);
    expect(sum(lines, 'debit')).toBe(sum(lines, 'credit'));
  });

  it('a card receipt splits the fee out of cash but credits AR at gross', () => {
    // Gross is what the customer paid and what Schedule C receipts must show;
    // the processor's cut is an expense, not a smaller sale.
    const lines = invoicePaymentLines({ amount: '600.00', processingFee: '17.70' });
    expect(lines[0]).toEqual({ code: '1000', side: 'debit', amount: '582.30' });
    expect(lines[1]).toEqual({ code: '7950', side: 'debit', amount: '17.70' });
    expect(lines[2]).toEqual({ code: '1200', side: 'credit', amount: '600.00' });
    expect(sum(lines, 'debit')).toBe(sum(lines, 'credit'));
  });

  it('a refund is the same lines flipped, and still balances', () => {
    const lines = invoicePaymentLines({ amount: '-250.00' });
    expect(lines).toEqual([
      { code: '1000', side: 'credit', amount: '250.00' },
      { code: '7950', side: 'credit', amount: '0.00' },
      { code: '1200', side: 'debit', amount: '250.00' },
    ]);
    expect(sum(lines, 'debit')).toBe(sum(lines, 'credit'));
  });

  it('a receipt and its exact refund net to nothing', () => {
    // The property that makes delete-a-payment safe: reversal must cancel the
    // original to the cent, or the origin period keeps a residue.
    const paid = invoicePaymentLines({ amount: '432.19', processingFee: '12.87' });
    const refund = invoicePaymentLines({ amount: '-432.19', processingFee: '12.87' });
    expect(sum(paid, 'debit') - sum(refund, 'debit')).toBe(0);
    expect(sum(paid, 'credit') - sum(refund, 'credit')).toBe(0);
  });
});

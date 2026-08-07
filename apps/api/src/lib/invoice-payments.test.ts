import { describe, expect, it } from 'vitest';
import { checkPaymentEligibility, summarizeSettlement } from './invoice-payments.js';
import { allocateProportionally, invoicePaymentLines } from './ledger.js';

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

  // TMC-196. Marking a never-issued draft paid is a counter sale: nobody was
  // ever owed anything, so the receipt credits Revenue directly and AR must
  // not appear at all.
  describe('the cash-sale shape', () => {
    // $600 of service + $200 of product + $64 tax = $864.
    const sale = {
      kind: 'cashSale' as const,
      serviceSubtotal: '600.00',
      productSubtotal: '200.00',
      tax: '64.00',
      total: '864.00',
    };

    it('a full receipt reproduces the invoice composition exactly', () => {
      const lines = invoicePaymentLines({ amount: '864.00', credit: sale });
      expect(lines).toEqual([
        { code: '1000', side: 'debit', amount: '864.00' },
        { code: '7950', side: 'debit', amount: '0.00' },
        { code: '4000', side: 'credit', amount: '600.00' },
        { code: '4100', side: 'credit', amount: '200.00' },
        { code: '2200', side: 'credit', amount: '64.00' },
      ]);
      expect(sum(lines, 'debit')).toBe(sum(lines, 'credit'));
    });

    it('never touches accounts receivable', () => {
      // The whole point. An AR leg here would be a receivable against a
      // customer who was never billed.
      const lines = invoicePaymentLines({ amount: '864.00', credit: sale });
      expect(lines.some((l) => l.code === '1200')).toBe(false);
    });

    it('a refund claws back revenue, not receivables', () => {
      const lines = invoicePaymentLines({ amount: '-108.00', credit: sale });
      // Cash goes out; revenue and tax come back down in proportion
      // (108 is one eighth of 864, so 75 / 25 / 8).
      expect(lines).toEqual([
        { code: '1000', side: 'credit', amount: '108.00' },
        { code: '7950', side: 'credit', amount: '0.00' },
        { code: '4000', side: 'debit', amount: '75.00' },
        { code: '4100', side: 'debit', amount: '25.00' },
        { code: '2200', side: 'debit', amount: '8.00' },
      ]);
      expect(sum(lines, 'debit')).toBe(sum(lines, 'credit'));
    });

    it('balances on an amount that does not divide cleanly', () => {
      // $100 split three ways is the case a round-each-leg implementation gets
      // wrong by a cent — and a one-cent imbalance does not post at all.
      const thirds = {
        kind: 'cashSale' as const,
        serviceSubtotal: '33.33',
        productSubtotal: '33.33',
        tax: '33.34',
        total: '100.00',
      };
      for (const amount of ['100.00', '33.33', '0.01', '66.67', '99.99']) {
        const lines = invoicePaymentLines({ amount, credit: thirds });
        expect(sum(lines, 'debit')).toBe(sum(lines, 'credit'));
        expect(sum(lines, 'credit')).toBe(Math.round(Number(amount) * 100));
      }
    });
  });
});

describe('allocateProportionally', () => {
  it('hands out every cent, never one more or fewer', () => {
    // Falsification: an implementation that rounds each share independently
    // passes the easy cases and fails these.
    const cases: Array<[number, number[]]> = [
      [10_000, [3333, 3333, 3334]],
      [1, [5000, 5000]],
      [99, [1, 1, 1]],
      [7, [100, 200, 300]],
      [864_00, [600_00, 200_00, 64_00]],
    ];
    for (const [total, weights] of cases) {
      const parts = allocateProportionally(total, weights);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
      expect(parts.every((p) => p >= 0)).toBe(true);
    }
  });

  it('reproduces the weights exactly when the whole amount is allocated', () => {
    // The property mark-paid depends on: a full receipt against a cash sale
    // must post the invoice's own numbers, not a re-derived approximation.
    expect(allocateProportionally(864_00, [600_00, 200_00, 64_00])).toEqual([
      600_00, 200_00, 64_00,
    ]);
  });

  it('puts everything on the first leg rather than dividing by zero', () => {
    expect(allocateProportionally(500, [0, 0, 0])).toEqual([500, 0, 0]);
  });
});

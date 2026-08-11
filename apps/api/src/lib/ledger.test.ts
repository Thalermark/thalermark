import { describe, expect, it } from 'vitest';
import {
  type LedgerLine,
  type ManualJournalLine,
  billOpenLines,
  billPaymentLines,
  capitalPurchaseLines,
  depreciationSchedule,
  expensePostingLines,
  flipManualLines,
  invoicePostingLines,
  loanPaymentLines,
  ownerMoneyEventLines,
  reverseLedgerLines,
  simpleOpeningBalanceLines,
} from './ledger.js';

// Sum the non-zero legs the way postJournalEntry would (it drops amount<=0
// lines before the balance check), so these assertions match what's persisted.
function nonZeroSides(lines: LedgerLine[]) {
  const kept = lines.filter((l) => Number(l.amount) > 0);
  const sum = (side: 'debit' | 'credit') =>
    kept.filter((l) => l.side === side).reduce((s, l) => s + Number(l.amount), 0);
  return { debit: sum('debit'), credit: sum('credit'), count: kept.length };
}

// Sum of debit amounts vs credit amounts — a posting is valid iff they're equal.
function sides(lines: LedgerLine[]) {
  const sum = (side: 'debit' | 'credit') =>
    lines.filter((l) => l.side === side).reduce((s, l) => s + Number(l.amount), 0);
  return { debit: sum('debit'), credit: sum('credit') };
}

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
      { code: '7950', side: 'debit', amount: '0.00' },
      { code: '4000', side: 'credit', amount: '100.00' },
      { code: '4100', side: 'credit', amount: '0.00' },
      { code: '2200', side: 'credit', amount: '8.25' },
    ]);
  });

  it('splits Cash / Merchant Fees when a processing fee rode along', () => {
    expect(invoicePostingLines('draft', 'paid', { ...taxed, processingFee: '3.44' })).toEqual([
      { code: '1000', side: 'debit', amount: '104.81' },
      { code: '7950', side: 'debit', amount: '3.44' },
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
      { code: '7950', side: 'debit', amount: '0.00' },
      { code: '1200', side: 'credit', amount: '108.25' },
    ]);
  });

  // TMC-156. Stripe deposits net of its cut, so Cash takes the net and the fee
  // lands on 7950 (Schedule C line 27a). AR still clears at gross — the
  // customer really did pay the full amount, and gross receipts must stay gross
  // to match the 1099-K Stripe files with the IRS.
  it('splits Cash (net) / Merchant Fees (fee) against AR at gross', () => {
    expect(invoicePostingLines('sent', 'paid', { ...taxed, processingFee: '3.44' })).toEqual([
      { code: '1000', side: 'debit', amount: '104.81' },
      { code: '7950', side: 'debit', amount: '3.44' },
      { code: '1200', side: 'credit', amount: '108.25' },
    ]);
  });

  it('a fee-split entry still balances', () => {
    const lines = invoicePostingLines('sent', 'paid', { ...taxed, processingFee: '3.44' });
    const { debit, credit, count } = nonZeroSides(lines);
    expect(debit).toBeCloseTo(credit, 2);
    expect(count).toBe(3);
  });

  // null is the manual mark-paid / fee-lookup-failed case and must collapse to
  // the original two-line shape once postJournalEntry drops the zero fee leg.
  it('null fee is indistinguishable from the pre-fee posting', () => {
    const withNull = invoicePostingLines('sent', 'paid', { ...taxed, processingFee: null });
    expect(withNull).toEqual(invoicePostingLines('sent', 'paid', taxed));
    expect(nonZeroSides(withNull).count).toBe(2);
  });

  // Sub-penny drift check: 2.9% + $0.30 on 108.25 is 3.44 (rounded by Stripe),
  // and subtractMoney works over the cents domain, so the legs must tie exactly
  // rather than to within a float epsilon.
  it('nets exactly with no floating-point residue', () => {
    const lines = invoicePostingLines('sent', 'paid', { ...untaxed, processingFee: '3.20' });
    expect(lines[0]).toEqual({ code: '1000', side: 'debit', amount: '96.80' });
    const { debit, credit } = sides(lines);
    expect(debit).toBe(credit);
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

// TMC-227. Pulling a sent invoice back to draft to correct it takes the
// receivable and the revenue off the books, exactly as voiding it would — the
// difference is what happens next, not what posts now.
describe('invoicePostingLines — sent → draft (pulled back to fix)', () => {
  it('reverses mark-sent: Dr Service Rev / Dr Product Rev / Dr Sales Tax / Cr AR', () => {
    expect(invoicePostingLines('sent', 'draft', taxed)).toEqual([
      { code: '4000', side: 'debit', amount: '100.00' },
      { code: '4100', side: 'debit', amount: '0.00' },
      { code: '2200', side: 'debit', amount: '8.25' },
      { code: '1200', side: 'credit', amount: '108.25' },
    ]);
  });

  it('debits both revenue accounts on a mixed product/service invoice', () => {
    expect(invoicePostingLines('sent', 'draft', mixed)).toEqual([
      { code: '4000', side: 'debit', amount: '60.00' },
      { code: '4100', side: 'debit', amount: '40.00' },
      { code: '2200', side: 'debit', amount: '8.25' },
      { code: '1200', side: 'credit', amount: '108.25' },
    ]);
  });

  // The load-bearing property: issue then pull back must leave nothing behind.
  // Every other check in this feature is downstream of this one. Compared by
  // code because the reversal lists AR last (the flip preserves input order),
  // and leg ORDER is not part of the posting's meaning.
  it('is the exact flip of the issue posting, leg for leg', () => {
    const byCode = (lines: LedgerLine[]) => [...lines].sort((a, b) => a.code.localeCompare(b.code));
    const issued = invoicePostingLines('draft', 'sent', mixed);
    expect(byCode(invoicePostingLines('sent', 'draft', mixed))).toEqual(
      byCode(reverseLedgerLines(issued)),
    );
  });

  it('an all-service, untaxed invoice collapses to two non-zero legs', () => {
    const lines = invoicePostingLines('sent', 'draft', untaxed);
    const { debit, credit, count } = nonZeroSides(lines);
    expect(count).toBe(2);
    expect(debit).toBe(credit);
  });

  // Symmetric with draft → sent: both legs of a zero-total document post
  // nothing (postJournalEntry returns null below two non-zero lines), so the
  // pair still nets to zero. A correction must not depend on an entry existing.
  it('emits only zero-amount lines for a zero-total invoice', () => {
    const lines = invoicePostingLines('sent', 'draft', zero);
    expect(lines.every((l) => Number(l.amount) === 0)).toBe(true);
  });

  // A card fee belongs to a payment, and a paid invoice cannot be pulled back.
  // Pinned so a future fee change cannot leak a 7950 leg into the reversal and
  // leave the origin period non-zero.
  it('ignores a stored processing fee — no Cash and no Merchant Fees leg', () => {
    const lines = invoicePostingLines('sent', 'draft', { ...taxed, processingFee: '3.44' });
    expect(lines.map((l) => l.code)).toEqual(['4000', '4100', '2200', '1200']);
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

describe('billOpenLines / billPaymentLines (accounts payable)', () => {
  it('open posts Dr <category> / Cr Accounts Payable (2000)', () => {
    expect(billOpenLines({ categoryCode: '7000', amount: '320.00' })).toEqual([
      { code: '7000', side: 'debit', amount: '320.00' },
      { code: '2000', side: 'credit', amount: '320.00' },
    ]);
  });

  it('payment posts Dr Accounts Payable (2000) / Cr <payment asset>', () => {
    expect(billPaymentLines({ paymentCode: '1000', amount: '320.00' })).toEqual([
      { code: '2000', side: 'debit', amount: '320.00' },
      { code: '1000', side: 'credit', amount: '320.00' },
    ]);
  });

  it('open + payment net AP (2000) to zero — the full bill lifecycle', () => {
    const lifecycle = [
      ...billOpenLines({ categoryCode: '7000', amount: '320.00' }),
      ...billPaymentLines({ paymentCode: '1000', amount: '320.00' }),
    ];
    const apNet = lifecycle
      .filter((l) => l.code === '2000')
      .reduce((sum, l) => sum + (l.side === 'credit' ? Number(l.amount) : -Number(l.amount)), 0);
    expect(apNet).toBe(0);
  });

  it('void = reverse(open) — undoes the AP credit and the expense debit', () => {
    const open = billOpenLines({ categoryCode: '7000', amount: '320.00' });
    expect(reverseLedgerLines(open)).toEqual([
      { code: '7000', side: 'credit', amount: '320.00' },
      { code: '2000', side: 'debit', amount: '320.00' },
    ]);
  });

  // Partial payments for bills (TMC-192).
  it('a payment carries its OWN asset code — two payments, two accounts', () => {
    expect(billPaymentLines({ paymentCode: '1010', amount: '160.00' })).toEqual([
      { code: '2000', side: 'debit', amount: '160.00' },
      { code: '1010', side: 'credit', amount: '160.00' },
    ]);
  });

  it('a negative payment is a vendor refund — the same lines, sides flipped', () => {
    expect(billPaymentLines({ paymentCode: '1000', amount: '-50.00' })).toEqual([
      { code: '2000', side: 'credit', amount: '50.00' },
      { code: '1000', side: 'debit', amount: '50.00' },
    ]);
  });

  it('open + two part-payments from different accounts still net AP to zero', () => {
    const lifecycle = [
      ...billOpenLines({ categoryCode: '7000', amount: '320.00' }),
      ...billPaymentLines({ paymentCode: '1000', amount: '160.00' }),
      ...billPaymentLines({ paymentCode: '1010', amount: '160.00' }),
    ];
    const apNet = lifecycle
      .filter((l) => l.code === '2000')
      .reduce((sum, l) => sum + (l.side === 'credit' ? Number(l.amount) : -Number(l.amount)), 0);
    expect(apNet).toBe(0);
  });

  // Removing a payment reverses it, so the pair must vanish from every account
  // it touched — not just AP. A residue on the asset side would be a silent
  // cash error nobody looks for.
  it('a payment and its reversal cancel on both legs', () => {
    const payment = billPaymentLines({ paymentCode: '1000', amount: '160.00' });
    const net = [...payment, ...reverseLedgerLines(payment)].reduce<Record<string, number>>(
      (acc, l) => {
        acc[l.code] =
          (acc[l.code] ?? 0) + (l.side === 'debit' ? Number(l.amount) : -Number(l.amount));
        return acc;
      },
      {},
    );
    expect(net).toEqual({ '2000': 0, '1000': 0 });
  });

  // A refund and its own removal, which is the double-negative case: the
  // reversal of an already-flipped entry must land back where it started.
  it('a refund and its reversal also cancel on both legs', () => {
    const refund = billPaymentLines({ paymentCode: '1000', amount: '-50.00' });
    const net = [...refund, ...reverseLedgerLines(refund)].reduce<Record<string, number>>(
      (acc, l) => {
        acc[l.code] =
          (acc[l.code] ?? 0) + (l.side === 'debit' ? Number(l.amount) : -Number(l.amount));
        return acc;
      },
      {},
    );
    expect(net).toEqual({ '2000': 0, '1000': 0 });
  });
});

describe('ownerMoneyEventLines (owner equity / draw)', () => {
  it("contribution posts Dr Cash (1000) / Cr Owner's Equity (3000)", () => {
    expect(ownerMoneyEventLines('contribution', '1500.00')).toEqual([
      { code: '1000', side: 'debit', amount: '1500.00' },
      { code: '3000', side: 'credit', amount: '1500.00' },
    ]);
  });

  it("draw posts Dr Owner's Draw (3100) / Cr Cash (1000)", () => {
    expect(ownerMoneyEventLines('draw', '800.00')).toEqual([
      { code: '3100', side: 'debit', amount: '800.00' },
      { code: '1000', side: 'credit', amount: '800.00' },
    ]);
  });

  it('reverse(create) nets Cash (1000) to zero — the edit/delete prelude', () => {
    const create = ownerMoneyEventLines('contribution', '400.00');
    const combined = [...create, ...reverseLedgerLines(create)];
    const cashNet = combined
      .filter((l) => l.code === '1000')
      .reduce((sum, l) => sum + (l.side === 'debit' ? Number(l.amount) : -Number(l.amount)), 0);
    expect(cashNet).toBe(0);
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

describe('simpleOpeningBalanceLines — the three plain questions, expanded', () => {
  it('cash only: Dr Cash / Cr Owner’s Equity, balanced', () => {
    const lines = simpleOpeningBalanceLines({
      cash: '100.00',
      receivables: '0.00',
      payables: '0.00',
    });
    expect(sides(lines).debit).toBeCloseTo(sides(lines).credit, 2);
    const cash = lines.find((l) => l.code === '1000');
    const equity = lines.find((l) => l.code === '3000');
    expect(cash).toMatchObject({ side: 'debit', amount: '100.00' });
    expect(equity).toMatchObject({ side: 'credit', amount: '100.00' });
  });

  it('cash + receivables + payables: equity plug = cash + AR − AP (credit), balanced', () => {
    const lines = simpleOpeningBalanceLines({
      cash: '500.00',
      receivables: '200.00',
      payables: '100.00',
    });
    expect(sides(lines).debit).toBeCloseTo(sides(lines).credit, 2);
    const equity = lines.find((l) => l.code === '3000');
    // 500 + 200 − 100 = 600
    expect(equity).toMatchObject({ side: 'credit', amount: '600.00' });
  });

  it('payables exceed assets: equity plug flips to a debit, balanced', () => {
    const lines = simpleOpeningBalanceLines({
      cash: '100.00',
      receivables: '0.00',
      payables: '300.00',
    });
    expect(sides(lines).debit).toBeCloseTo(sides(lines).credit, 2);
    const equity = lines.find((l) => l.code === '3000');
    // 100 − 300 = −200 → a debit of 200 to Owner's Equity
    expect(equity).toMatchObject({ side: 'debit', amount: '200.00' });
  });

  it('reversal nets the opening entry to zero per code', () => {
    const lines = simpleOpeningBalanceLines({
      cash: '500.00',
      receivables: '200.00',
      payables: '100.00',
    });
    const combined = [...lines, ...reverseLedgerLines(lines)];
    const byCode = new Map<string, number>();
    for (const l of combined) {
      const signed = l.side === 'debit' ? Number(l.amount) : -Number(l.amount);
      byCode.set(l.code, (byCode.get(l.code) ?? 0) + signed);
    }
    for (const net of byCode.values()) expect(net).toBe(0);
  });
});

describe('capitalPurchaseLines — big purchase posting', () => {
  it('paid in full, deduct now: Dr Equipment + §179 write-off, balanced, no loan leg', () => {
    const lines = capitalPurchaseLines({
      amount: '3600.00',
      paidNow: '3600.00',
      taxTreatment: 'deduct_now',
    });
    const s = nonZeroSides(lines);
    expect(s.debit).toBeCloseTo(s.credit, 2);
    // Dr Equipment 3600 / Cr Cash 3600 / Dr DepExp 3600 / Cr AccumDep 3600 — the
    // zero loan leg drops.
    expect(s.count).toBe(4);
    expect(lines.find((l) => l.code === '2700')).toMatchObject({ amount: '0.00' });
    expect(lines.find((l) => l.code === '1500')).toMatchObject({
      side: 'debit',
      amount: '3600.00',
    });
    expect(lines.find((l) => l.code === '6350')).toMatchObject({
      side: 'debit',
      amount: '3600.00',
    });
    expect(lines.find((l) => l.code === '1900')).toMatchObject({
      side: 'credit',
      amount: '3600.00',
    });
  });

  it('paid in full, spread: capitalize only (no depreciation legs), balanced', () => {
    const lines = capitalPurchaseLines({
      amount: '3600.00',
      paidNow: '3600.00',
      taxTreatment: 'spread',
    });
    const s = nonZeroSides(lines);
    expect(s.debit).toBeCloseTo(s.credit, 2);
    expect(s.count).toBe(2); // Dr Equipment / Cr Cash
    expect(lines.find((l) => l.code === '6350')).toBeUndefined();
  });

  it('financed with a down payment: splits Cash + Loans Payable, balanced', () => {
    const lines = capitalPurchaseLines({
      amount: '3600.00',
      paidNow: '600.00',
      taxTreatment: 'spread',
    });
    const s = nonZeroSides(lines);
    expect(s.debit).toBeCloseTo(s.credit, 2);
    expect(lines.find((l) => l.code === '1000')).toMatchObject({
      side: 'credit',
      amount: '600.00',
    });
    // 3600 − 600 = 3000 financed
    expect(lines.find((l) => l.code === '2700')).toMatchObject({
      side: 'credit',
      amount: '3000.00',
    });
  });

  it('fully financed: no cash leg, full amount to Loans Payable', () => {
    const lines = capitalPurchaseLines({
      amount: '3600.00',
      paidNow: '0.00',
      taxTreatment: 'deduct_now',
    });
    const s = nonZeroSides(lines);
    expect(s.debit).toBeCloseTo(s.credit, 2);
    expect(lines.find((l) => l.code === '1000')).toMatchObject({ amount: '0.00' }); // dropped
    expect(lines.find((l) => l.code === '2700')).toMatchObject({
      side: 'credit',
      amount: '3600.00',
    });
  });
});

describe('loanPaymentLines — payment toward a financed purchase', () => {
  it('no interest: Dr Loans / Cr Cash, balanced', () => {
    const lines = loanPaymentLines({ amount: '300.00', interest: '0.00' });
    const s = nonZeroSides(lines);
    expect(s.debit).toBeCloseTo(s.credit, 2);
    expect(s.count).toBe(2);
    expect(lines.find((l) => l.code === '2700')).toMatchObject({ side: 'debit', amount: '300.00' });
  });

  it('with interest: principal to Loans, interest to Interest Expense, balanced', () => {
    const lines = loanPaymentLines({ amount: '300.00', interest: '20.00' });
    const s = nonZeroSides(lines);
    expect(s.debit).toBeCloseTo(s.credit, 2);
    expect(lines.find((l) => l.code === '2700')).toMatchObject({ side: 'debit', amount: '280.00' });
    expect(lines.find((l) => l.code === '6500')).toMatchObject({ side: 'debit', amount: '20.00' });
    expect(lines.find((l) => l.code === '1000')).toMatchObject({
      side: 'credit',
      amount: '300.00',
    });
  });
});

describe('depreciationSchedule — the plain "spread it out" answer', () => {
  const halfYear = { convention: 'half_year' as const, purchaseYear: 2026 };
  const fullYear = { convention: 'full_year' as const, purchaseYear: 2026 };

  it('halves the purchase year and spills the other half into year N+1', () => {
    // The IRS default convention: bought in June or in December, the asset
    // counts as placed in service mid-year either way.
    const plan = depreciationSchedule('3600.00', 5, halfYear);
    expect(plan.perYear).toBe('720.00');
    expect(plan.firstYear).toBe('360.00');
    expect(plan.years).toBe(6);
    expect(plan.rows).toEqual([
      { year: 2026, amount: '360.00' },
      { year: 2027, amount: '720.00' },
      { year: 2028, amount: '720.00' },
      { year: 2029, amount: '720.00' },
      { year: 2030, amount: '720.00' },
      { year: 2031, amount: '360.00' },
    ]);
  });

  it('gives the purchase year a whole chunk under the accountant override', () => {
    const plan = depreciationSchedule('3600.00', 5, fullYear);
    expect(plan.firstYear).toBe('720.00');
    expect(plan.years).toBe(5);
    expect(plan.rows.at(-1)).toEqual({ year: 2030, amount: '720.00' });
  });

  it('sums to exactly the cost when the split does not divide evenly', () => {
    // $1,000 over 3 years is 333.33/yr, which leaves a cent adrift five times
    // over. An asset has to end fully written off — a stray cent on a tax form
    // is a support ticket, so the last row absorbs the remainder.
    for (const opts of [halfYear, fullYear]) {
      const plan = depreciationSchedule('1000.00', 3, opts);
      const summed = plan.rows.reduce((cents, r) => cents + Math.round(Number(r.amount) * 100), 0);
      expect(summed).toBe(100_000);
      expect(plan.total).toBe('1000.00');
    }
  });

  it('clamps a non-positive life to one year', () => {
    expect(depreciationSchedule('1000.00', 0, fullYear).rows).toEqual([
      { year: 2026, amount: '1000.00' },
    ]);
    // A 1-year half_year plan is degenerate: half up front, and the remainder
    // rather than another half, so it still totals the cost instead of going
    // negative on the final row.
    expect(depreciationSchedule('1000.00', 0, halfYear).rows).toEqual([
      { year: 2026, amount: '500.00' },
      { year: 2027, amount: '500.00' },
    ]);
  });
});

describe('flipManualLines — manual journal entry reversal', () => {
  // The coaAccountId-keyed sibling of reverseLedgerLines (manual entries pick
  // accounts by id, not fixed code). Integration coverage of postManual/reverse
  // lives in apps/api/tests/ledger-adjustments.integration.test.ts.
  const entry: ManualJournalLine[] = [
    { coaAccountId: 'acc-dep-exp', side: 'debit', amount: '500.00' },
    { coaAccountId: 'acc-accum-dep', side: 'credit', amount: '500.00' },
  ];

  it('flips each side, preserving account + amount', () => {
    expect(flipManualLines(entry)).toEqual([
      { coaAccountId: 'acc-dep-exp', side: 'credit', amount: '500.00' },
      { coaAccountId: 'acc-accum-dep', side: 'debit', amount: '500.00' },
    ]);
  });

  it('is its own inverse — flip(flip(x)) === x', () => {
    expect(flipManualLines(flipManualLines(entry))).toEqual(entry);
  });

  it('original + reversal net to zero per account', () => {
    const combined = [...entry, ...flipManualLines(entry)];
    const byAccount = new Map<string, number>();
    for (const l of combined) {
      const signed = l.side === 'debit' ? Number(l.amount) : -Number(l.amount);
      byAccount.set(l.coaAccountId, (byAccount.get(l.coaAccountId) ?? 0) + signed);
    }
    for (const net of byAccount.values()) {
      expect(net).toBe(0);
    }
  });
});

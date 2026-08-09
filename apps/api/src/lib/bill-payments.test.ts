import { describe, expect, it } from 'vitest';
import { checkBillPaymentEligibility, summarizeBillSettlement } from './bill-payments.js';

// The pure half of the accounts-payable settlement rules (TMC-192). The
// arithmetic itself is summarizeSettlement's, already covered in
// invoice-payments.test.ts and reused rather than reimplemented — what is tested
// here is the part that is genuinely different: the status the arithmetic maps
// to, and which bills may take a payment at all.

describe('summarizeBillSettlement', () => {
  it('no payments reads unpaid and leaves the bill open', () => {
    expect(summarizeBillSettlement({ amountCents: 32_000, paidCents: 0 })).toEqual({
      settlement: 'unpaid',
      paid: '0.00',
      outstanding: '320.00',
      status: 'open',
    });
  });

  it('a deposit reads partial and leaves the bill open', () => {
    expect(summarizeBillSettlement({ amountCents: 32_000, paidCents: 16_000 })).toEqual({
      settlement: 'partial',
      paid: '160.00',
      outstanding: '160.00',
      status: 'open',
    });
  });

  it('paying it off reads paid', () => {
    expect(summarizeBillSettlement({ amountCents: 32_000, paidCents: 32_000 })).toEqual({
      settlement: 'paid',
      paid: '320.00',
      outstanding: '0.00',
      status: 'paid',
    });
  });

  it('overpaying a vendor is a real state, not an error', () => {
    expect(summarizeBillSettlement({ amountCents: 32_000, paidCents: 35_000 })).toEqual({
      settlement: 'overpaid',
      paid: '350.00',
      outstanding: '-30.00',
      status: 'paid',
    });
  });

  // The reason 'open' exists as a separate mapping at all: summarizeSettlement
  // speaks invoice and would say 'sent' here, which is not a bill status.
  it('a full refund reopens the bill — it is owed again, which is true', () => {
    expect(summarizeBillSettlement({ amountCents: 32_000, paidCents: 0 }).status).toBe('open');
    // 160 out, 160 back.
    expect(summarizeBillSettlement({ amountCents: 32_000, paidCents: 16_000 - 16_000 })).toEqual({
      settlement: 'unpaid',
      paid: '0.00',
      outstanding: '320.00',
      status: 'open',
    });
  });
});

describe('checkBillPaymentEligibility', () => {
  it('an open bill takes a payment', () => {
    expect(checkBillPaymentEligibility({ status: 'open', existingPaymentCount: 0 })).toEqual({
      ok: true,
    });
  });

  it('a voided bill does not — its liability was reversed', () => {
    expect(checkBillPaymentEligibility({ status: 'voided', existingPaymentCount: 0 })).toEqual({
      ok: false,
      reason: 'voided',
    });
  });

  // The guard that makes this safe to ship against live data: a bill settled by
  // the old single-shot mark-paid has header stamps and no rows, and its cash
  // has already left. Accepting a payment would pay the vendor twice.
  it('refuses a bill settled through the legacy header-only path', () => {
    expect(checkBillPaymentEligibility({ status: 'paid', existingPaymentCount: 0 })).toEqual({
      ok: false,
      reason: 'settled_without_payments',
    });
  });

  // ...but a bill paid THROUGH rows stays open to a correction, or the only way
  // to fix a mistyped payment would be to void a legitimately paid bill.
  it('allows a correction against a bill that was paid through rows', () => {
    expect(checkBillPaymentEligibility({ status: 'paid', existingPaymentCount: 2 })).toEqual({
      ok: true,
    });
  });
});

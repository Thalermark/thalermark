import { describe, expect, it } from 'vitest';
import { SOLE_PROP_COA, chartForBusinessType, coaOverlayFor } from './coa.js';

// Chart-of-accounts shape per business type (TMC-124). The DB-backed behaviour
// (seeding, reconciling) lives in coa-reconcile.test.ts; this file is pure.

// The codes apps/api/src/lib/ledger.ts posts against by literal. If any of these
// stops existing on any entity type, posting silently breaks — this is the guard.
const LEDGER_POSTING_CODES = [
  '1000', // cash
  '1200', // accounts receivable
  '1500', // equipment
  '1900', // accumulated depreciation
  '2000', // accounts payable
  '2200', // sales tax payable
  '2700', // loans payable
  '3000', // owner capital in
  '3100', // owner money out
  '4000', // service revenue
  '4100', // product revenue
  '6350', // depreciation expense
  '6500', // interest expense
  '7950', // merchant processing fees
];

const ALL_TYPES = ['sole_prop', 'llc_single_member', 'partnership', 's_corp', 'c_corp'] as const;

describe('chartForBusinessType', () => {
  it.each(ALL_TYPES)('%s carries every code the ledger posts to', (bt) => {
    const codes = new Set(chartForBusinessType(bt).map((a) => a.code));
    for (const code of LEDGER_POSTING_CODES) {
      expect(codes).toContain(code);
    }
  });

  it.each(ALL_TYPES)('%s has unique codes, in code order', (bt) => {
    const codes = chartForBusinessType(bt).map((a) => a.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toEqual([...codes].sort());
  });

  it.each(ALL_TYPES)('%s gives every account a valid type and normal balance', (bt) => {
    for (const a of chartForBusinessType(bt)) {
      expect(['asset', 'liability', 'equity', 'revenue', 'expense']).toContain(a.accountType);
      expect(['debit', 'credit']).toContain(a.normalBalance);
      expect(a.name.trim()).not.toBe('');
    }
  });

  // A single-member LLC is a disregarded entity — same return, so the same
  // chart, down to the wording. Not a fallback.
  it('gives a single-member LLC the identical sole-prop chart', () => {
    expect(chartForBusinessType('llc_single_member')).toEqual(chartForBusinessType('sole_prop'));
  });

  // The signup hook seeds before the welcome wizard captures an answer.
  it('falls back to the sole-prop chart when the type is unknown or unset', () => {
    expect(chartForBusinessType(null)).toEqual(SOLE_PROP_COA);
    expect(chartForBusinessType(undefined)).toEqual(SOLE_PROP_COA);
    expect(chartForBusinessType('nonsense')).toEqual(SOLE_PROP_COA);
  });

  it('maps every expense and revenue account to a line on its own return', () => {
    for (const bt of ALL_TYPES) {
      const form = coaOverlayFor(bt).taxForm;
      for (const a of chartForBusinessType(bt)) {
        if (a.accountType !== 'expense' && a.accountType !== 'revenue') continue;
        expect(a.taxMapping, `${bt} ${a.code} ${a.name}`).toBeTruthy();
        // Schedule C's mapping string says "Schedule C"; the corporate/partnership
        // ones name their form. Either way it must reference the right return.
        const stem = form.replace(' (Form 1040)', '');
        expect(a.taxMapping, `${bt} ${a.code}`).toContain(stem);
      }
    }
  });

  // Balance-sheet accounts have no P&L line to roll up to on any of these forms.
  it.each(ALL_TYPES)('%s leaves balance-sheet accounts unmapped', (bt) => {
    for (const a of chartForBusinessType(bt)) {
      if (a.accountType === 'expense' || a.accountType === 'revenue') continue;
      expect(a.taxMapping, `${bt} ${a.code} ${a.name}`).toBeNull();
    }
  });
});

describe('entity-specific accounts', () => {
  const byCode = (bt: string) => new Map(chartForBusinessType(bt).map((a) => [a.code, a]));

  it('names the owner equity accounts for the entity', () => {
    expect(byCode('sole_prop').get('3000')?.name).toBe("Owner's Equity");
    expect(byCode('sole_prop').get('3100')?.name).toBe("Owner's Draw");
    expect(byCode('partnership').get('3000')?.name).toBe("Partners' Capital");
    expect(byCode('partnership').get('3100')?.name).toBe("Partners' Draws");
    expect(byCode('s_corp').get('3100')?.name).toBe('Shareholder Distributions');
    // The word is the point: a C-corp shareholder takes a dividend out of
    // already-taxed earnings, which is what double taxation looks like.
    expect(byCode('c_corp').get('3100')?.name).toBe('Dividends Paid');
  });

  // Form 1065 line 10 exists precisely so partner compensation doesn't get
  // mixed into employee wages on line 9. A partner can't be their own employee.
  it('gives a partnership guaranteed payments, separate from wages', () => {
    const coa = byCode('partnership');
    expect(coa.get('7550')?.taxMapping).toBe('Form 1065, Line 10');
    expect(coa.get('7500')?.taxMapping).toBe('Form 1065, Line 9');
    expect(byCode('sole_prop').has('7550')).toBe(false);
  });

  // 1120-S line 7 vs line 8, and 1120 line 12 vs line 13 — the IRS watches the
  // ratio of officer pay to other wages, so the form separates them and so do we.
  it('gives both corporation types officer compensation on its own line', () => {
    expect(byCode('s_corp').get('7450')?.taxMapping).toBe('Form 1120-S, Line 7');
    expect(byCode('s_corp').get('7500')?.taxMapping).toBe('Form 1120-S, Line 8');
    expect(byCode('c_corp').get('7450')?.taxMapping).toBe('Form 1120, Line 12');
    expect(byCode('c_corp').get('7500')?.taxMapping).toBe('Form 1120, Line 13');
    expect(byCode('partnership').has('7450')).toBe(false);
    expect(byCode('sole_prop').has('7450')).toBe(false);
  });

  it('gives both corporation types the equity a corporation actually has', () => {
    for (const bt of ['s_corp', 'c_corp']) {
      const coa = byCode(bt);
      expect(coa.get('3000')?.name).toBe('Capital Stock');
      expect(coa.get('3200')?.name).toBe('Additional Paid-in Capital');
      expect(coa.get('3400')?.name).toBe('Retained Earnings');
      expect(coa.get('3400')?.accountType).toBe('equity');
    }
    expect(byCode('sole_prop').has('3400')).toBe(false);
    expect(byCode('partnership').has('3400')).toBe(false);
  });

  // The one thing that genuinely separates a C-corp: it pays income tax itself.
  // Every other entity type here is a pass-through and never carries the
  // liability on its own books.
  it('gives only a C-corp its own income tax accounts', () => {
    const ccorp = byCode('c_corp');
    expect(ccorp.get('2400')?.name).toBe('Income Taxes Payable');
    expect(ccorp.get('7800')?.name).toBe('Income Tax Expense');
    for (const bt of ['sole_prop', 'llc_single_member', 'partnership', 's_corp']) {
      expect(byCode(bt).has('2400'), bt).toBe(false);
      expect(byCode(bt).has('7800'), bt).toBe(false);
    }
  });

  // Income tax is NOT a deductible expense on the corporation's own return —
  // mapping it into Other deductions (line 26) would understate taxable income.
  it('keeps C-corp income tax off the deductions line', () => {
    expect(byCode('c_corp').get('7800')?.taxMapping).toBe('Form 1120, Line 31');
  });

  // Neither 1065 nor the 1120s has a line for advertising, supplies, travel and
  // the rest — they file as one "other deductions" total with an itemised
  // statement, which is exactly what these accounts produce.
  it('rolls the accounts with no dedicated line into other deductions', () => {
    expect(byCode('partnership').get('7000')?.taxMapping).toBe('Form 1065, Line 21');
    expect(byCode('s_corp').get('7000')?.taxMapping).toBe('Form 1120-S, Line 20');
    expect(byCode('c_corp').get('7000')?.taxMapping).toBe('Form 1120, Line 26');
    // Advertising does get its own line on the 1120s, but not on the 1065.
    expect(byCode('partnership').get('6000')?.taxMapping).toBe('Form 1065, Line 21');
    expect(byCode('s_corp').get('6000')?.taxMapping).toBe('Form 1120-S, Line 16');
    expect(byCode('c_corp').get('6000')?.taxMapping).toBe('Form 1120, Line 22');
  });

  // Schedule C splits rent into 20a/20b; every other form has a single Rents
  // line, so both accounts feed it.
  it('collapses the two rent accounts onto one line for non-Schedule-C forms', () => {
    expect(byCode('sole_prop').get('6800')?.taxMapping).toBe('Schedule C, Line 20a');
    expect(byCode('sole_prop').get('6850')?.taxMapping).toBe('Schedule C, Line 20b');
    expect(byCode('s_corp').get('6800')?.taxMapping).toBe('Form 1120-S, Line 11');
    expect(byCode('s_corp').get('6850')?.taxMapping).toBe('Form 1120-S, Line 11');
  });
});

describe('coaOverlayFor', () => {
  it('names the return each entity files', () => {
    expect(coaOverlayFor('sole_prop').taxForm).toBe('Schedule C (Form 1040)');
    expect(coaOverlayFor('llc_single_member').taxForm).toBe('Schedule C (Form 1040)');
    expect(coaOverlayFor('partnership').taxForm).toBe('Form 1065');
    expect(coaOverlayFor('s_corp').taxForm).toBe('Form 1120-S');
    expect(coaOverlayFor('c_corp').taxForm).toBe('Form 1120');
  });
});

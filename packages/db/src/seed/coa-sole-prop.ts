import type { CoaOverlay } from './coa.js';

// Schedule C (Form 1040), Profit or Loss From Business — the return filed by a
// sole proprietor AND by a single-member LLC, which the IRS treats as a
// disregarded entity. Both business types share this overlay; that's correct,
// not a fallback.
//
// This is the base chart's own wording, so there's nothing to rename and nothing
// to add — the whole overlay is the tax mapping. The expense codes in the base
// chart were laid out in Schedule C Part II line order for exactly this reason.
//
// Line numbers are from the 2024 form. Part II numbering has been structurally
// stable for decades — the only changes in ~20 years were cosmetic (2018 TCJA
// dropped entertainment from 24b, 2019 reworded the 1099 checkboxes, 2022
// repurposed 27b) — so expect to touch this roughly once every few years.
//
// Balance-sheet accounts (cash, receivables, equipment, payables, equity) carry
// no mapping: Schedule C has no balance sheet. Lines with no account of ours —
// 12 depletion, 14 employee benefits, 16a mortgage interest, 19 pension — still
// render on the worksheet, at zero, so a user comparing against the IRS PDF
// finds every line (see apps/api/src/lib/tax-worksheet.ts).
export const SOLE_PROP_OVERLAY: CoaOverlay = {
  taxForm: 'Schedule C (Form 1040)',
  taxMapping: {
    // Part I — Income. Line 1 is gross receipts; both revenue accounts feed it.
    '4000': 'Schedule C, Line 1',
    '4100': 'Schedule C, Line 1',

    // Part II — Expenses, in form order.
    '6000': 'Schedule C, Line 8', // Advertising
    '6100': 'Schedule C, Line 9', // Car and truck expenses
    '6200': 'Schedule C, Line 10', // Commissions and fees
    '6300': 'Schedule C, Line 11', // Contract labor
    '6350': 'Schedule C, Line 13', // Depreciation and section 179
    '6400': 'Schedule C, Line 15', // Insurance (other than health)
    '6500': 'Schedule C, Line 16b', // Interest — other
    '6600': 'Schedule C, Line 17', // Legal and professional services
    '6700': 'Schedule C, Line 18', // Office expense
    '6800': 'Schedule C, Line 20a', // Rent — vehicles, machinery, equipment
    '6850': 'Schedule C, Line 20b', // Rent — other business property
    '6900': 'Schedule C, Line 21', // Repairs and maintenance
    '7000': 'Schedule C, Line 22', // Supplies
    '7100': 'Schedule C, Line 23', // Taxes and licenses
    '7200': 'Schedule C, Line 24a', // Travel
    '7300': 'Schedule C, Line 24b', // Deductible meals
    '7400': 'Schedule C, Line 25', // Utilities
    '7500': 'Schedule C, Line 26', // Wages (less employment credits)
    '7900': 'Schedule C, Line 27a', // Other expenses
    '7950': 'Schedule C, Line 27a', // Merchant processing fees
  },
};

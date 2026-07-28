import type { CoaOverlay } from './coa.js';

// Form 1065, U.S. Return of Partnership Income — filed by a general partnership
// and by a multi-member LLC, which defaults to partnership taxation.
//
// Two things make a partnership's chart different from a sole proprietor's.
//
// Equity is owned by partners collectively rather than by one person, so 3000
// and 3100 become Partners' Capital and Partners' Draws. These stay POOLED —
// one capital account, one draw account — because that is the shape Form 1065
// itself reports: Schedule L line 21 is a single "Partners' capital accounts"
// figure, and Schedule M-2 analyses that one balance. Per-partner splitting is a
// Schedule K-1 concern, and K-1s are something a preparer produces from the
// partnership agreement's allocation percentages, not something these books can
// derive. If per-partner ledger accounts are ever wanted, that needs a partners
// entity and a "which partner" prompt on every owner-money event — a much larger
// change than a chart.
//
// Guaranteed payments (line 10) are the partnership's version of paying yourself
// for work done. They are NOT wages — a partner can't be their own employee — and
// the form gives them their own line precisely so they don't get mixed in with
// employee salaries on line 9. So they get their own account, sitting right after
// Wages to mirror that pairing on the form.
//
// The big structural difference from Schedule C: Form 1065's deduction section is
// far shorter. It has no line for advertising, office expense, supplies, travel,
// meals, utilities, insurance, legal fees or commissions — all of them land on
// line 21, "Other deductions", which is filed with an attached itemised
// statement. So most of the chart maps to line 21 by design, and the accounts
// remain the thing that produces that statement.
export const PARTNERSHIP_OVERLAY: CoaOverlay = {
  taxForm: 'Form 1065',
  rename: {
    '3000': "Partners' Capital",
    '3100': "Partners' Draws",
  },
  extra: [
    {
      code: '7550',
      name: 'Guaranteed Payments to Partners',
      accountType: 'expense',
      normalBalance: 'debit',
    },
  ],
  taxMapping: {
    // Income. Line 1a is gross receipts or sales.
    '4000': 'Form 1065, Line 1a',
    '4100': 'Form 1065, Line 1a',

    // Deductions, in form order.
    '7500': 'Form 1065, Line 9', // Salaries and wages (other than to partners)
    '7550': 'Form 1065, Line 10', // Guaranteed payments to partners
    '6900': 'Form 1065, Line 11', // Repairs and maintenance
    '6800': 'Form 1065, Line 13', // Rent (one line — both rent accounts feed it)
    '6850': 'Form 1065, Line 13',
    '7100': 'Form 1065, Line 14', // Taxes and licenses
    '6500': 'Form 1065, Line 15', // Interest
    '6350': 'Form 1065, Line 16a', // Depreciation

    // Line 21, Other deductions — everything the form has no dedicated line for.
    // (Line 20 is the energy efficient commercial buildings deduction as of
    // TY2023; these sat on 20 until TMC-167 corrected them.)
    '6000': 'Form 1065, Line 21', // Advertising
    '6100': 'Form 1065, Line 21', // Car and truck
    '6200': 'Form 1065, Line 21', // Commissions and fees
    '6300': 'Form 1065, Line 21', // Contract labor
    '6400': 'Form 1065, Line 21', // Insurance
    '6600': 'Form 1065, Line 21', // Legal and professional
    '6700': 'Form 1065, Line 21', // Office expense
    '7000': 'Form 1065, Line 21', // Supplies
    '7200': 'Form 1065, Line 21', // Travel
    '7300': 'Form 1065, Line 21', // Meals
    '7400': 'Form 1065, Line 21', // Utilities
    '7900': 'Form 1065, Line 21', // Other expenses
    '7950': 'Form 1065, Line 21', // Merchant processing fees
  },
};

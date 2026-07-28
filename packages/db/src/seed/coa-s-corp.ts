import type { CoaOverlay } from './coa.js';

// Form 1120-S, U.S. Income Tax Return for an S Corporation.
//
// An S-corp is a corporation, so its equity section is genuinely different from a
// sole proprietor's rather than differently-worded. Money the owner puts in buys
// stock (capital stock, plus anything above par as additional paid-in capital);
// profit that stays in the business accumulates as retained earnings; money the
// owner takes out is a distribution against those earnings, not a draw against
// their own capital. So 3000 and 3100 are renamed and two more equity accounts
// are added.
//
// The other structural difference is that an S-corp owner who works in the
// business IS an employee and must be paid a reasonable salary — that's the
// defining compliance obligation of the entity type. Form 1120-S puts officer
// compensation on line 7, deliberately separate from everyone else's wages on
// line 8, because the IRS is watching that ratio. So officer pay gets its own
// account sitting immediately before Wages, mirroring the form.
//
// We do not run payroll. Seeding these accounts means the numbers from whatever
// payroll service the business uses (Gusto, ADP, a bookkeeper) have somewhere
// correct to land via the ledger portal — including the employer-side taxes
// withheld but not yet remitted, which is what Payroll Taxes Payable holds.
//
// Retained earnings is seeded but nothing posts to it automatically: closing the
// year's revenue and expenses into it is a year-end close, which we don't have.
// The ledger portal can post that entry by hand.
//
// Like Form 1065, 1120-S has a much shorter deduction list than Schedule C — no
// line for office expense, supplies, travel, meals, utilities, insurance, legal
// fees or commissions. Those land on line 20, Other deductions, with an attached
// statement. Advertising, unlike on 1065, does get its own line (16).
export const S_CORP_OVERLAY: CoaOverlay = {
  taxForm: 'Form 1120-S',
  rename: {
    '3000': 'Capital Stock',
    '3100': 'Shareholder Distributions',
  },
  extra: [
    {
      code: '2300',
      name: 'Payroll Taxes Payable',
      accountType: 'liability',
      normalBalance: 'credit',
    },
    {
      code: '3200',
      name: 'Additional Paid-in Capital',
      accountType: 'equity',
      normalBalance: 'credit',
    },
    { code: '3400', name: 'Retained Earnings', accountType: 'equity', normalBalance: 'credit' },
    { code: '7450', name: 'Officer Compensation', accountType: 'expense', normalBalance: 'debit' },
  ],
  taxMapping: {
    // Income. Line 1a is gross receipts or sales.
    '4000': 'Form 1120-S, Line 1a',
    '4100': 'Form 1120-S, Line 1a',

    // Deductions, in form order.
    '7450': 'Form 1120-S, Line 7', // Compensation of officers
    '7500': 'Form 1120-S, Line 8', // Salaries and wages (less employment credits)
    '6900': 'Form 1120-S, Line 9', // Repairs and maintenance
    '6800': 'Form 1120-S, Line 11', // Rents (one line — both rent accounts feed it)
    '6850': 'Form 1120-S, Line 11',
    '7100': 'Form 1120-S, Line 12', // Taxes and licenses
    '6500': 'Form 1120-S, Line 13', // Interest
    '6350': 'Form 1120-S, Line 14', // Depreciation
    '6000': 'Form 1120-S, Line 16', // Advertising

    // Line 20, Other deductions — everything without a dedicated line. (Line 19
    // is the energy efficient commercial buildings deduction as of TY2023;
    // these sat on 19 until TMC-167 corrected them.)
    '6100': 'Form 1120-S, Line 20', // Car and truck
    '6200': 'Form 1120-S, Line 20', // Commissions and fees
    '6300': 'Form 1120-S, Line 20', // Contract labor
    '6400': 'Form 1120-S, Line 20', // Insurance
    '6600': 'Form 1120-S, Line 20', // Legal and professional
    '6700': 'Form 1120-S, Line 20', // Office expense
    '7000': 'Form 1120-S, Line 20', // Supplies
    '7200': 'Form 1120-S, Line 20', // Travel
    '7300': 'Form 1120-S, Line 20', // Meals
    '7400': 'Form 1120-S, Line 20', // Utilities
    '7900': 'Form 1120-S, Line 20', // Other expenses
    '7950': 'Form 1120-S, Line 20', // Merchant processing fees
  },
};

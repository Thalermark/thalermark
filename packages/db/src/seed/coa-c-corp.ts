import type { CoaOverlay } from './coa.js';

// Form 1120, U.S. Corporation Income Tax Return.
//
// A C-corp's chart is the S-corp's chart plus the one thing that actually
// separates the two entity types: a C corporation pays income tax itself. Every
// other business type in this product is a pass-through — the profit lands on the
// owner's personal return and the business books never carry a tax liability. A
// C-corp does, so it needs Income Tax Expense and Income Taxes Payable, and
// nothing else in the product would ever have seeded them.
//
// The second difference is what money out to the owner means. An S-corp
// shareholder takes a distribution against earnings already taxed to them; a
// C-corp shareholder takes a dividend, paid from earnings the corporation has
// already paid tax on, and gets taxed again personally. Same account, same
// posting, different word — and the word matters, because it's the thing that
// makes double taxation visible.
//
// Note that Income Tax Expense maps to line 31 (Total tax), NOT to line 26
// (Other deductions). Income tax is not a deductible business expense on its own
// return — mapping it into other deductions would understate taxable income. It
// is deliberately carved out of the line-26 block below.
//
// As with the S-corp: no payroll here, so officer compensation and payroll taxes
// payable exist to receive figures from an outside payroll service via the ledger
// portal. Retained earnings is seeded but nothing closes into it automatically.
export const C_CORP_OVERLAY: CoaOverlay = {
  taxForm: 'Form 1120',
  rename: {
    '3000': 'Capital Stock',
    '3100': 'Dividends Paid',
  },
  extra: [
    {
      code: '2300',
      name: 'Payroll Taxes Payable',
      accountType: 'liability',
      normalBalance: 'credit',
    },
    {
      code: '2400',
      name: 'Income Taxes Payable',
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
    { code: '7800', name: 'Income Tax Expense', accountType: 'expense', normalBalance: 'debit' },
  ],
  taxMapping: {
    // Income. Line 1a is gross receipts or sales.
    '4000': 'Form 1120, Line 1a',
    '4100': 'Form 1120, Line 1a',

    // Deductions, in form order.
    '7450': 'Form 1120, Line 12', // Compensation of officers
    '7500': 'Form 1120, Line 13', // Salaries and wages (less employment credits)
    '6900': 'Form 1120, Line 14', // Repairs and maintenance
    '6800': 'Form 1120, Line 16', // Rents (one line — both rent accounts feed it)
    '6850': 'Form 1120, Line 16',
    '7100': 'Form 1120, Line 17', // Taxes and licenses
    '6500': 'Form 1120, Line 18', // Interest
    '6350': 'Form 1120, Line 20', // Depreciation from Form 4562
    '6000': 'Form 1120, Line 22', // Advertising

    // Line 26, Other deductions — everything without a dedicated line.
    '6100': 'Form 1120, Line 26', // Car and truck
    '6200': 'Form 1120, Line 26', // Commissions and fees
    '6300': 'Form 1120, Line 26', // Contract labor
    '6400': 'Form 1120, Line 26', // Insurance
    '6600': 'Form 1120, Line 26', // Legal and professional
    '6700': 'Form 1120, Line 26', // Office expense
    '7000': 'Form 1120, Line 26', // Supplies
    '7200': 'Form 1120, Line 26', // Travel
    '7300': 'Form 1120, Line 26', // Meals
    '7400': 'Form 1120, Line 26', // Utilities
    '7900': 'Form 1120, Line 26', // Other expenses
    '7950': 'Form 1120, Line 26', // Merchant processing fees

    // Not a deduction — the corporation's own tax, reported after taxable income.
    '7800': 'Form 1120, Line 31', // Total tax
  },
};

import { z } from 'zod';
import type { BusinessType } from './company.js';

// Year-end close (TMC-159) — rolling a fiscal year's revenue and expense
// accounts into equity so the next year starts at zero, and locking the year so
// nothing can silently change it afterwards.
//
// Lives behind "The Ledger" portal (the `ledger:adjust` capability), which is
// the one place accounting vocabulary is shown on purpose. Even there we spend
// the vocabulary budget sparingly: the user reads "close out 2026", never
// "closing entries".

// Which equity account a year's profit rolls into, by entity type.
//
// 3400 Retained Earnings is seeded ONLY for the two corp types (see
// packages/db/src/seed/) — a sole proprietor has nowhere to put an accumulating
// earnings balance and doesn't need one, because their profit belongs to them
// personally the moment it's earned. So sole props and partnerships close into
// 3000 (Owner's Equity / Partners' Capital) and corps close into 3400, which is
// the balance Form 1120 / 1120-S Schedule L actually reports.
//
// Null business type (never captured) follows the sole-prop chart that was
// seeded provisionally, same convention as filesScheduleC.
export const COA_OWNER_EQUITY = '3000';
export const COA_RETAINED_EARNINGS = '3400';

export function periodCloseEquityCode(businessType: string | null | undefined): string {
  return businessType === 's_corp' || businessType === 'c_corp'
    ? COA_RETAINED_EARNINGS
    : COA_OWNER_EQUITY;
}

// How the close names its destination, in the user's words. The corp wording is
// the one term we don't soften — an S-corp owner's accountant will say "retained
// earnings", and matching it is the point of the feature.
export function periodCloseEquityLabel(businessType: string | null | undefined): string {
  switch (businessType) {
    case 's_corp':
    case 'c_corp':
      return 'Retained earnings';
    case 'partnership':
      return "Partners' capital";
    default:
      return "Owner's equity";
  }
}

// Belt-and-braces for the label above when the seeded account has been renamed.
export const PERIOD_CLOSE_EQUITY_LABELS: Record<BusinessType, string> = {
  sole_prop: "Owner's equity",
  llc_single_member: "Owner's equity",
  partnership: "Partners' capital",
  s_corp: 'Retained earnings',
  c_corp: 'Retained earnings',
};

// The year being closed. Bounded to the same range as the DB CHECK; the API
// additionally rejects a year that hasn't finished yet in the company's
// timezone — you cannot close a year you are still living through.
export const fiscalYearSchema = z.number().int().min(1900).max(2999);

export const periodCloseCreateSchema = z.object({
  companyId: z.string().uuid(),
  fiscalYear: fiscalYearSchema,
});

export type PeriodCloseCreateInput = z.infer<typeof periodCloseCreateSchema>;

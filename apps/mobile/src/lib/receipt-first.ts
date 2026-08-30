// Photo-first expense entry (TMC-295 / TMC-283): the pure half of the flow —
// turning an extract-receipt response into a form prefill, and turning a
// failure into the right sentence. Pure so it's testable without a device
// (the mobile test convention); the network half lives in upload.ts.

import type { ExtractReceiptBody } from './upload';

export type ExtractionPrefill = {
  merchant?: string;
  amount?: string;
  expenseDate?: string;
  categoryAccountId?: string;
};

// A partial read is KEPT, not discarded (TMC-295): every non-null field
// prefills, the rest are simply left alone — nothing is invented to fill them.
// The suggested category is dropped unless it names one of the company's
// loaded expense accounts, so a stale suggestion can never leave the picker
// showing a uuid with no name.
export function extractionPrefill(
  body: ExtractReceiptBody,
  knownCategoryIds: ReadonlySet<string>,
): ExtractionPrefill {
  const prefill: ExtractionPrefill = {};
  if (body.extraction.merchant) prefill.merchant = body.extraction.merchant;
  if (body.extraction.total) prefill.amount = body.extraction.total;
  if (body.extraction.expenseDate) prefill.expenseDate = body.extraction.expenseDate;
  if (body.suggestedCategoryAccountId && knownCategoryIds.has(body.suggestedCategoryAccountId)) {
    prefill.categoryAccountId = body.suggestedCategoryAccountId;
  }
  return prefill;
}

export const hasPrefill = (p: ExtractionPrefill): boolean => Object.keys(p).length > 0;

// The fallback is automatic and silent about blame (TMC-295): no dead end, no
// "try a clearer photo" as a wall. Whatever went wrong, the person still gets
// the form and the photo still saves with the expense — the notice only says
// which of those two things is true.
export function readFailureNotice(code: string): string {
  if (code === 'ai_not_configured') {
    return "Receipts aren't read automatically on this server — the photo will still be saved. Turn reading on in Settings → AI.";
  }
  return "Couldn't read the receipt this time. Fill it in below — the photo will still be saved.";
}

export const READ_OK_NOTICE = 'Read from your receipt — check the details and save.';
export const READ_PARTIAL_NOTICE =
  'Read part of your receipt — fill in the rest and save. The photo saves with the expense.';

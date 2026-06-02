import type { ExtractionResult } from './types.js';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// The raw shape the model is asked to produce (see extractor.ts). Money comes
// back as numbers — models are more reliable emitting a JSON number than a
// pre-formatted decimal string — and we format to a 2-dp string here so the
// result matches the rest of the money-on-the-wire convention.
export interface RawExtraction {
  merchant: string | null;
  total: number | null;
  expenseDate: string | null;
  taxAmount: number | null;
  suggestedCategoryCode: string | null;
}

// Format a model-supplied money number to a fixed 2-dp decimal string, or null
// when it's missing / not a sane non-negative amount. Receipts never carry a
// negative total, so a negative is treated as a misread rather than passed on.
function money(n: number | null | undefined): string | null {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  return n.toFixed(2);
}

function text(s: string | null | undefined): string | null {
  if (typeof s !== 'string') return null;
  const trimmed = s.trim();
  return trimmed === '' ? null : trimmed;
}

// Constrain a model-suggested category code to the codes we handed it. A
// hallucinated code (not in the company's expense COA) is nulled — a suggestion
// that wouldn't post is no suggestion. Shared by receipt extraction and text
// categorization.
export function constrainCode(
  code: string | null | undefined,
  allowedCodes: string[],
): string | null {
  const c = text(code);
  return c && allowedCodes.includes(c) ? c : null;
}

// Turn the model's raw output into a clean ExtractionResult, dropping anything
// malformed and constraining the suggested category to the codes we handed the
// model. Pure + total — the unit tests exercise this rather than the live
// model call.
export function normalizeExtraction(raw: RawExtraction, allowedCodes: string[]): ExtractionResult {
  const expenseDate = text(raw.expenseDate);
  return {
    merchant: text(raw.merchant),
    total: money(raw.total),
    // Bare-date only; a timestamp or prose date is dropped rather than coerced.
    expenseDate: expenseDate && ISO_DATE_RE.test(expenseDate) ? expenseDate : null,
    taxAmount: money(raw.taxAmount),
    suggestedCategoryCode: constrainCode(raw.suggestedCategoryCode, allowedCodes),
  };
}

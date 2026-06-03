// Invoice / estimate auto-numbering. Smart-detect: increment the trailing
// integer of the company's most recent number while keeping prefix +
// zero-padding intact. Preserves whatever convention the user adopted
// ("INV-0042" → "INV-0043", "2026-007" → "2026-008", "42" → "43"). No prior
// number OR no trailing integer → the locked first default. Single source of
// truth for the suggestion lives here so the API endpoints, the
// duplicate-as-template clone, and the recurring-invoice sweeper all agree.
const FIRST_INVOICE_DEFAULT = 'INV-0001';
const FIRST_ESTIMATE_DEFAULT = 'EST-0001';
const TRAILING_INT_RE = /^(.*?)(\d+)$/;

function nextNumberWithDefault(latest: string | undefined, defaultValue: string): string {
  if (!latest) return defaultValue;
  const match = TRAILING_INT_RE.exec(latest);
  if (!match) return defaultValue;
  const [, prefix, digits] = match;
  const next = (BigInt(digits ?? '0') + 1n).toString();
  const padded = next.padStart((digits ?? '').length, '0');
  return `${prefix ?? ''}${padded}`;
}

export function suggestNextInvoiceNumber(latest: string | undefined): string {
  return nextNumberWithDefault(latest, FIRST_INVOICE_DEFAULT);
}

export function suggestNextEstimateNumber(latest: string | undefined): string {
  return nextNumberWithDefault(latest, FIRST_ESTIMATE_DEFAULT);
}

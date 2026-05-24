import { z } from 'zod';

// Money + quantity flow over the wire as decimal-formatted strings, not JSON
// numbers. JSON numbers are IEEE-754 doubles — accepting "100.10" + "0.20" as
// floats would silently round in places no one wants rounding (subtotal/tax
// math, line-item totals). Clients format with .toFixed(...) (or a money
// library) before POST; the server validates shape and stores in
// numeric(15,2) / numeric(15,4) columns as-is.
//
// 2 fractional digits for amounts, 4 for quantity (matches the DB columns).
// Leading zero required ("0.50" not ".50"); negatives intentionally rejected
// — credits/refunds get a dedicated representation when that feature lands.
export const moneyString = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, 'money must be a decimal string with up to 2 fractional digits')
  .refine((s) => s.length <= 18, 'money exceeds 15-digit precision');

export const quantityString = z
  .string()
  .regex(/^\d+(\.\d{1,4})?$/, 'quantity must be a decimal string with up to 4 fractional digits')
  .refine((s) => s.length <= 20, 'quantity exceeds 15-digit precision');

// ISO 8601 calendar date (YYYY-MM-DD), no time, no zone. Mirrors the
// drizzle `date({ mode: 'string' })` column type for invoice issue/due dates.
export const isoDateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD');

// Decimal-string math. The invoice schema is locked on "client computes,
// server stores as-sent" — both the SvelteKit action and the Svelte page
// preview need identical arithmetic, so the helpers live here next to the
// primitives they produce. BigInt-backed to dodge IEEE-754 drift on sums.
//
// Rounding is half-away-from-zero (standard invoice / spreadsheet behaviour:
// 0.005 → 0.01, not banker's 0.00). Tolerant of malformed input — empty or
// non-decimal strings read as zero so the form's pre-validation preview can
// keep computing while the user is mid-type, and the server action can run
// the math before schema validation without a try/catch on every cell. The
// downstream schema validation still surfaces the real "not a money string"
// field error. Negatives are not produced — moneyString rejects them at the
// boundary, and the helpers don't introduce subtraction paths.

const MONEY_SCALE = 2;
const QUANTITY_SCALE = 4;
const DECIMAL_RE = /^\d+(\.\d+)?$/;

function toScaled(s: string, scale: number): bigint {
  if (!DECIMAL_RE.test(s)) return 0n;
  const dot = s.indexOf('.');
  const intPart = dot === -1 ? s : s.slice(0, dot);
  const fracPart = dot === -1 ? '' : s.slice(dot + 1);
  const padded = (fracPart + '0'.repeat(scale)).slice(0, scale);
  return BigInt(intPart + padded);
}

function fromScaled(n: bigint, scale: number): string {
  const s = n.toString().padStart(scale + 1, '0');
  return scale === 0 ? s : `${s.slice(0, -scale)}.${s.slice(-scale)}`;
}

// Half-away-from-zero divide of a non-negative bigint by a positive divisor.
function roundDiv(n: bigint, divisor: bigint): bigint {
  return (n + divisor / 2n) / divisor;
}

export function multiplyMoney(quantity: string, unitPrice: string): string {
  const q = toScaled(quantity, QUANTITY_SCALE);
  const p = toScaled(unitPrice, MONEY_SCALE);
  const productAtScale6 = q * p;
  // Drop from scale 6 back to MONEY_SCALE (2) with half-up rounding.
  const dropDivisor = 10n ** BigInt(QUANTITY_SCALE);
  return fromScaled(roundDiv(productAtScale6, dropDivisor), MONEY_SCALE);
}

export function sumMoney(values: readonly string[]): string {
  let total = 0n;
  for (const v of values) total += toScaled(v, MONEY_SCALE);
  return fromScaled(total, MONEY_SCALE);
}

export function addMoney(a: string, b: string): string {
  return sumMoney([a, b]);
}

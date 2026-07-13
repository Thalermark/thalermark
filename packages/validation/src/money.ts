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

// Tax rate as a percent decimal string, up to 4 fractional digits ("8.25",
// "8.8750"). Mirrors tax_policies.rate_pct numeric(7,4). Capped at 100 so a
// fat-fingered "825" (meant as 8.25) fails the schema instead of levying an
// 825% tax.
export const taxRateString = z
  .string()
  .regex(/^\d+(\.\d{1,4})?$/, 'tax rate must be a decimal string with up to 4 fractional digits')
  .refine((s) => Number(s) <= 100, 'tax rate must not exceed 100');

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
const RATE_SCALE = 4;
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

// Exact integer-cents helpers for server-side totals that sumMoney can't
// express: a running total accumulated in a loop, or a signed result — a net or
// running balance that can dip below zero (sumMoney only sums non-negative
// amounts). Parse to cents, do integer math (exact for any realistic total —
// cents stay far under Number.MAX_SAFE_INTEGER), format once at the end. This is
// the fix for report totals that summed with Number(...) + float arithmetic and
// could land a cent off the ledger. toCents reads a money string, tolerating a
// leading '-' so a signed SQL sum (e.g. credit − debit) round-trips;
// centsToMoney formats a possibly-negative integer cent count to a 2-dp string.
export function toCents(money: string): number {
  const negative = money.startsWith('-');
  const cents = Number(toScaled(negative ? money.slice(1) : money, MONEY_SCALE));
  return negative ? -cents : cents;
}

export function centsToMoney(cents: number): string {
  const negative = cents < 0;
  const digits = String(Math.abs(cents)).padStart(MONEY_SCALE + 1, '0');
  const body = `${digits.slice(0, -MONEY_SCALE)}.${digits.slice(-MONEY_SCALE)}`;
  return negative ? `-${body}` : body;
}

// Per-line tax: amount × ratePct ÷ 100, rounded half-away-from-zero to the
// money scale. amount is a money string (scale 2), ratePct a percent string
// (scale 4). Both client preview and server recompute call this so a taxable
// line and the derived invoice tax can never drift. Tolerant of malformed
// input the same way the other helpers are (reads as zero), so a mid-type
// preview keeps computing.
//
// amount_scaled2 (a) × rate_scaled4 (r) = amount×ratePct at scale 6. Dividing
// that by 10^6 lands amount×ratePct÷100 back at the money scale in one rounded
// step (10^4 drops scale 6 → scale 2; the extra 10^2 is the percent's /100).
export function taxOfAmount(amount: string, ratePct: string): string {
  const a = toScaled(amount, MONEY_SCALE);
  const r = toScaled(ratePct, RATE_SCALE);
  const divisor = 10n ** BigInt(MONEY_SCALE + RATE_SCALE);
  return fromScaled(roundDiv(a * r, divisor), MONEY_SCALE);
}

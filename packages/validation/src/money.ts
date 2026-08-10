import { z } from 'zod';

// Money + quantity flow over the wire as decimal-formatted strings, not JSON
// numbers. JSON numbers are IEEE-754 doubles — accepting "100.10" + "0.20" as
// floats would silently round in places no one wants rounding (subtotal/tax
// math, line-item totals). Clients format with .toFixed(...) (or a money
// library) before POST; the server validates shape and stores in
// numeric(15,2) / numeric(15,4) columns as-is.
//
// 2 fractional digits for amounts, 4 for quantity (matches the DB columns).
// Leading zero required ("0.50" not ".50"); negatives rejected — an invoice
// line, a subtotal or an expense is never negative. The dedicated
// representation this used to promise for credits/refunds is signedMoneyString
// below, which landed with partial payments (TMC-187).
// The messages are the ones a user reads under the field, not a note to the
// developer about the wire format (TMC-221). They name an example rather than a
// rule, because "up to 2 fractional digits" is not how anyone thinks about a
// price. The negative case is called out explicitly: the regex rejects a minus
// sign, and "enter an amount like 125.00" would otherwise leave someone typing
// a refund with no idea what is wrong.
export const moneyString = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, 'Enter an amount like 125.00, with no minus sign.')
  .refine((s) => s.length <= 18, 'That amount is too large.');

// Money that may be negative — the representation for a refund or a credit
// note, which are recorded as negative payments rather than as a second entity
// (TMC-187). Deliberately NOT a widening of moneyString: the places that accept
// a negative are few and each is a decision, so they opt in by name.
//
// Zero is rejected. A zero-amount receipt records nothing, posts nothing (the
// journal helper drops zero lines and then refuses the under-2-line entry), and
// exists only to confuse a later reader of the payment list.
export const signedMoneyString = z
  .string()
  .regex(
    /^-?\d+(\.\d{1,2})?$/,
    'Enter an amount like 125.00, or -125.00 to record money going back.',
  )
  .refine((s) => s.length <= 19, 'That amount is too large.')
  .refine((s) => Number(s) !== 0, 'Enter an amount other than zero.');

// Unit price allows up to 4 fractional digits (numeric(15,4)) — finer than a
// money amount so a line total that doesn't divide evenly by the quantity can
// still be represented exactly (e.g. $650 over 7 units → $92.8571/unit, which
// multiplies back to $650.00). Amounts / subtotals / totals stay 2dp
// (moneyString); only the per-unit price carries the extra precision.
export const priceString = z
  .string()
  .regex(/^\d+(\.\d{1,4})?$/, 'Enter a price like 92.50, with no minus sign.')
  .refine((s) => s.length <= 20, 'That price is too large.');

export const quantityString = z
  .string()
  .regex(/^\d+(\.\d{1,4})?$/, 'Enter a quantity like 3 or 1.5, with no minus sign.')
  .refine((s) => s.length <= 20, 'That quantity is too large.');

// Tax rate as a percent decimal string, up to 4 fractional digits ("8.25",
// "8.8750"). Mirrors tax_policies.rate_pct numeric(7,4). Capped at 100 so a
// fat-fingered "825" (meant as 8.25) fails the schema instead of levying an
// 825% tax.
export const taxRateString = z
  .string()
  .regex(/^\d+(\.\d{1,4})?$/, 'Enter a rate like 8.25 — the number only, without a percent sign.')
  .refine((s) => Number(s) <= 100, "A tax rate can't be more than 100%.");

// ISO 8601 calendar date (YYYY-MM-DD), no time, no zone. Mirrors the
// drizzle `date({ mode: 'string' })` column type for invoice issue/due dates.
export const isoDateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a date like 2026-08-10.');

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
const PRICE_SCALE = 4;
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
  const p = toScaled(unitPrice, PRICE_SCALE);
  // Product is at scale QUANTITY_SCALE + PRICE_SCALE (8); drop back to
  // MONEY_SCALE (2) with half-away-from-zero rounding. Widening the price scale
  // from 2 to 4 is backward-compatible — a 2dp price like "92.85" still yields
  // "649.95" — while a 4dp price like "92.8571" now reaches "650.00" at qty 7.
  const productAtScale8 = q * p;
  const dropDivisor = 10n ** BigInt(QUANTITY_SCALE + PRICE_SCALE - MONEY_SCALE);
  return fromScaled(roundDiv(productAtScale8, dropDivisor), MONEY_SCALE);
}

// Back-compute the unit price a desired line TOTAL implies for a quantity, at
// PRICE_SCALE (4dp): round(total ÷ quantity). The inverse of multiplyMoney —
// `unitPriceFromTotal("650.00","7")` = "92.8571", and `multiplyMoney("7",
// "92.8571")` = "650.00". Powers the "type the line total" UX: the client writes
// the result into the unit-price field, so the stored representation stays
// quantity + 4dp unit price (amount is still multiplyMoney of the two). A zero /
// blank quantity has no meaningful per-unit price → "0.0000".
export function unitPriceFromTotal(total: string, quantity: string): string {
  const q = toScaled(quantity, QUANTITY_SCALE);
  if (q === 0n) return fromScaled(0n, PRICE_SCALE);
  // total is at MONEY_SCALE (2), q at QUANTITY_SCALE (4); scale the numerator so
  // the integer divide lands the quotient at PRICE_SCALE (4).
  const t = toScaled(total, MONEY_SCALE);
  const numerator = t * 10n ** BigInt(PRICE_SCALE + QUANTITY_SCALE - MONEY_SCALE);
  return fromScaled(roundDiv(numerator, q), PRICE_SCALE);
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

// Display a stored unit price (numeric(15,4), e.g. "92.8571" or a legacy
// "10.0000") with 2–4 decimals: always at least 2, at most 4, trimming trailing
// zeros beyond the second. "10.0000"→"10.00", "92.8500"→"92.85",
// "92.8571"→"92.8571". Read/customer-facing views use this so a price widened to
// 4dp by the migration doesn't render as "10.0000". Non-decimal input is padded
// to 2dp; anything unparseable falls through unchanged.
export function formatUnitPrice(price: string): string {
  if (!DECIMAL_RE.test(price)) return price;
  const dot = price.indexOf('.');
  if (dot === -1) return `${price}.00`;
  let frac = price.slice(dot + 1);
  while (frac.length > MONEY_SCALE && frac.endsWith('0')) frac = frac.slice(0, -1);
  if (frac.length < MONEY_SCALE) frac = frac.padEnd(MONEY_SCALE, '0');
  return `${price.slice(0, dot)}.${frac}`;
}

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

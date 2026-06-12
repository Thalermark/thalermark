import { z } from 'zod';

// Business types surfaced by the slice L3 wizard. Wire format is the
// snake_case internal code (matches what the L1 schema CHECK constraint
// — added in migration 0027 — pins the column to); UI maps these to the
// human labels ("Sole proprietor", "LLC (single-member)", etc.). Per the
// locked ledger decision, MVP seeds the sole-prop COA regardless of the
// pick; the column captures the operator's real answer for the v1.x
// entity-aware seeder switch.
export const BUSINESS_TYPES = [
  'sole_prop',
  'llc_single_member',
  'partnership',
  's_corp',
  'c_corp',
] as const;

export const businessTypeSchema = z.enum(BUSINESS_TYPES);
export type BusinessType = z.infer<typeof businessTypeSchema>;

// Input schema for PATCH /api/companies/:id. Sparse on purpose — the L3
// wizard updates name + businessType together, but follow-on flows (rename
// from settings, accountant updates business type alone) only touch one
// field. Sparse semantics rely on the typed Hono client treating `undefined`
// as "leave alone", matching the customer PATCH idiom for editable strings.
// At least one of the two fields must be present.
// Reply-to is nullable on the wire: an empty field from settings clears it
// (sets the column back to null → no Reply-To header). `null` and a valid
// email are both accepted; `undefined` means "leave alone" per the sparse
// idiom. We trim then coerce empty-string to null so a cleared input doesn't
// fail the email check.
const replyToEmailField = z
  .union([z.string().trim().email(), z.literal(''), z.null()])
  .transform((v) => (v ? v : null))
  .optional();

// Offline payment instructions (cash/check/Venmo/Zelle). Same nullable-on-the-
// wire idiom as replyToEmail: a cleared field arrives as '' and coerces to null
// so the column clears; `undefined` means "leave alone" (sparse). These are
// display-only strings, not validated against any provider — Venmo/Zelle have
// no API — so we only trim + cap length.
const optionalText = (max: number) =>
  z
    .union([z.string().trim().max(max), z.literal(''), z.null()])
    .transform((v) => (v ? v : null))
    .optional();

export const companyUpdateSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    businessType: businessTypeSchema.optional(),
    replyToEmail: replyToEmailField,
    paymentCashEnabled: z.boolean().optional(),
    paymentCheckEnabled: z.boolean().optional(),
    paymentCheckPayableTo: optionalText(200),
    paymentCheckAddress: optionalText(500),
    paymentVenmoHandle: optionalText(100),
    paymentZelleContact: optionalText(200),
    // Business identity shown on invoices. Same nullable-on-the-wire idiom as
    // the rest: '' clears the column, `undefined` leaves it alone. Free-text,
    // generously sized — address is multi-line, phone is unvalidated since
    // formats vary by locale and it's display-only.
    businessAddress: optionalText(500),
    businessPhone: optionalText(50),
  })
  // Sparse: at least one field must be present (zod only surfaces keys that
  // were actually sent, so an empty body fails this).
  .refine((v) => Object.keys(v).length > 0, {
    message: 'at_least_one_field_required',
  });

export type CompanyUpdateInput = z.infer<typeof companyUpdateSchema>;

// Input for POST /api/companies — adding another business to an existing
// workspace (the first company is seeded at signup). Both fields required, so
// the new company starts fully named + typed and never trips the first-run
// gate. Optional identity/payment fields are intentionally NOT here: keep
// creation a two-field decision, then the operator fills the rest from settings
// (or the create flow can PATCH them after). Sole-prop COA is seeded server-side
// regardless of type, same as signup (per the locked ledger decision).
export const companyCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  businessType: businessTypeSchema,
});

export type CompanyCreateInput = z.infer<typeof companyCreateSchema>;

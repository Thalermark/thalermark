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

export const companyUpdateSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    businessType: businessTypeSchema.optional(),
    replyToEmail: replyToEmailField,
  })
  .refine(
    (v) => v.name !== undefined || v.businessType !== undefined || v.replyToEmail !== undefined,
    {
      message: 'at_least_one_field_required',
    },
  );

export type CompanyUpdateInput = z.infer<typeof companyUpdateSchema>;

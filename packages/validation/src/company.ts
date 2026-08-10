import { z } from 'zod';

// Business types surfaced by the onboarding + create-company wizards. Wire
// format is the snake_case internal code (matches what the schema CHECK
// constraint — added in migration 0027 — pins the column to); UI maps these to
// the human labels ("Sole proprietor", "LLC (single-member)", etc.).
//
// All five are seeded and selectable as of TMC-124: each one gets a chart of
// accounts built against the federal return it actually files (see
// packages/db/src/seed/coa.ts). The stored value drives that chart, so changing
// it re-maps the company's accounts.
export const BUSINESS_TYPES = [
  'sole_prop',
  'llc_single_member',
  'partnership',
  's_corp',
  'c_corp',
] as const;

export const businessTypeSchema = z.enum(BUSINESS_TYPES);
export type BusinessType = z.infer<typeof businessTypeSchema>;

// How the pickers describe each business type. Deliberately not the legal
// wording: a landscaper knows whether it's "just me" or "me and a partner", and
// may have no idea what a "disregarded entity" is. The legal term rides along in
// parentheses where it helps someone recognise the setup their accountant named,
// and is dropped where the plain phrase already says it.
//
// Lives here, next to the enum, because both clients render this list and four
// hand-kept copies of it drifted the moment any of them was edited.
export const BUSINESS_TYPE_LABELS: Record<BusinessType, string> = {
  sole_prop: 'Just me (sole proprietor)',
  llc_single_member: 'Just me, with an LLC',
  partnership: 'Me and a partner or two (partnership)',
  s_corp: 'A corporation, taxed as an S-corp',
  c_corp: 'A corporation, taxed as a C-corp',
};

// The federal return each entity type files, in the words the IRS uses. Shared
// across web + mobile so the product can say "your business files Form 1120-S"
// wherever it has to explain that a Schedule C surface isn't theirs. Mirrors the
// `taxForm` on each COA overlay in packages/db — kept here rather than fetched
// because it's a constant of US tax law, not per-company data.
export const TAX_FORM_BY_BUSINESS_TYPE: Record<BusinessType, string> = {
  sole_prop: 'Schedule C (Form 1040)',
  llc_single_member: 'Schedule C (Form 1040)',
  partnership: 'Form 1065',
  s_corp: 'Form 1120-S',
  c_corp: 'Form 1120',
};

// Whether this entity reports its profit on Schedule C. True for a sole
// proprietor and for a single-member LLC — the IRS treats the latter as a
// disregarded entity, so both file the same form. Everything else files a
// return of its own, and showing it a Schedule C worksheet would be wrong.
//
// Null (business type not captured yet) counts as true: the chart seeded before
// the wizard's answer is the sole-prop one, so the Schedule C surfaces match it.
// Takes a plain string so callers can pass a `BusinessType` without tripping
// tuple-narrowing.
export function filesScheduleC(businessType: string | null | undefined): boolean {
  return !businessType || businessType === 'sole_prop' || businessType === 'llc_single_member';
}

// Accounting method — when the business counts income (TMC-155). Orthogonal to
// business type: Schedule C asks them as separate questions (entity type, then
// line F "(1) Cash (2) Accrual"), and a sole proprietor may elect either. So
// this is its own column, not something derived from businessType.
//
// 'cash' is the default and the right answer for effectively the whole
// audience — you are only forced onto accrual by real inventory or receipts in
// the tens of millions. Deliberately NOT asked during onboarding: the product
// principle is that users never pick accounting concepts, so Settings surfaces
// this as "When do you count income?" rather than as a basis toggle.
//
// The general ledger is always accrual regardless of this value — the books
// record events when they happen. This only selects the reporting lens applied
// at read time (see the Schedule C export), which is the same one-ledger model
// QuickBooks and Xero use.
export const ACCOUNTING_METHODS = ['cash', 'accrual'] as const;

export const accountingMethodSchema = z.enum(ACCOUNTING_METHODS);
export type AccountingMethod = z.infer<typeof accountingMethodSchema>;

// How much of a year's write-off a "spread it out" purchase takes in the year
// it was bought (TMC-123).
//
// 'half_year' is the IRS default convention: an asset is treated as placed in
// service at the middle of the year whatever month it was actually bought, so
// year one takes half a chunk and the spread runs one year longer. Nothing in
// US tax law hands out a *full* year in the purchase year, which makes
// 'full_year' the outlier — it exists only because an accountant who has
// already been depreciating an asset that way needs our figures to agree with
// the return they file.
//
// Never asked of the person who bought the thing; they answer "deduct it all
// this year" vs "spread it out" and nothing else. Settings carries this beside
// accountingMethod with the same don't-change-this-casually framing.
export const DEPRECIATION_CONVENTIONS = ['half_year', 'full_year'] as const;

export const depreciationConventionSchema = z.enum(DEPRECIATION_CONVENTIONS);
export type DepreciationConvention = z.infer<typeof depreciationConventionSchema>;

// How the business deducts vehicle costs (TMC-179). The IRS lets you take a flat
// rate per business mile OR your actual gas/repairs/insurance/depreciation, and
// never both for one vehicle — the standard rate is a statutory substitute that
// already absorbs all of them.
//
// 'standard' is the default and the right one for nearly everyone here. It is
// also the only one this product can compute: 'actual' needs a per-vehicle split
// of expenses and a business-use percentage, neither of which exists in the
// schema, so choosing it means "leave mileage off my return" rather than
// "work out the other number for me". Settings says exactly that.
export const VEHICLE_EXPENSE_METHODS = ['standard', 'actual'] as const;

export const vehicleExpenseMethodSchema = z.enum(VEHICLE_EXPENSE_METHODS);
export type VehicleExpenseMethod = z.infer<typeof vehicleExpenseMethodSchema>;

export const VEHICLE_EXPENSE_METHOD_LABELS: Record<VehicleExpenseMethod, string> = {
  standard: 'Standard mileage',
  actual: 'Actual vehicle expenses',
};

// IANA timezone the company's reporting day boundaries resolve in (TMC-157).
//
// Validated by asking Intl to build a formatter for it: that's the same tz
// database Node ships, so anything it accepts is a real zone. We deliberately
// don't enumerate zones — the list changes between tzdata releases, and a
// hardcoded set would reject valid input (or accept retired input) depending on
// which side of a release you're on.
//
// This runs at the API boundary specifically so an unknown zone can't reach
// SQL: the window queries interpolate it into `AT TIME ZONE`, where a bad value
// throws mid-query rather than returning a clean 400.
export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const timezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(isValidTimeZone, { message: 'That is not a time zone we recognise.' });

// Input schema for PATCH /api/companies/:id. Sparse on purpose — the L3
// wizard updates name + businessType together, but follow-on flows (rename
// from settings, accountant updates business type alone) only touch one
// field. Sparse semantics rely on the typed Hono client treating `undefined`
// as "leave alone", matching the contact PATCH idiom for editable strings.
// At least one of the two fields must be present.
// Nullable-email field idiom (reply-to + business email): an empty field from
// settings clears it (sets the column back to null); `null` and a valid email
// are both accepted; `undefined` means "leave alone" per the sparse idiom. We
// trim then coerce empty-string to null so a cleared input doesn't fail the
// email check.
const nullableEmailField = z
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

// Automated payment reminders (TMC-189).
//
// The schedule is a list of day offsets relative to each invoice's due date;
// negative is before it falls due. The UI splits them into "before it's due" and
// "after it's due" and never shows a minus sign — the same reason the refund
// control offers a direction rather than asking for a negative number.
//
// BOTH BOUNDS ARE A SAFETY FEATURE, NOT TIDINESS. This sends mail to third
// parties from a shared sending domain. Someone who sets fifteen reminders is
// not chasing an invoice, they are harassing a customer and burning our
// deliverability while they do it. Six stages is more than any legitimate
// schedule needs.
//
// -30..+90 bounds each stage: a reminder more than a month before an invoice
// falls due is not a reminder, and one more than a quarter late belongs in a
// conversation rather than an automated email.
export const MAX_REMINDER_STAGES = 6;
export const MIN_REMINDER_OFFSET = -30;
export const MAX_REMINDER_OFFSET = 90;

export const reminderOffsetsSchema = z
  .array(z.number().int().min(MIN_REMINDER_OFFSET).max(MAX_REMINDER_OFFSET))
  .max(MAX_REMINDER_STAGES)
  // Duplicates would be silently swallowed anyway — the send log is unique on
  // (invoice, offset), so a repeated 7 could only ever send once. Rejecting it
  // at save time says so out loud instead of letting the UI show a stage that
  // never fires.
  .refine((v) => new Set(v).size === v.length, { message: 'That reminder is already in the list.' })
  // Stored sorted so the settings screen and the send order agree without the
  // UI having to sort, and so two schedules with the same stages compare equal.
  .transform((v) => [...v].sort((a, b) => a - b));

export const companyUpdateSchema = z
  .object({
    // Sparse like the rest: omitted leaves the schedule alone. An empty array is
    // a legitimate value meaning "enabled but nothing scheduled" — which sends
    // nothing, and is a less surprising state than silently re-adding defaults.
    remindersEnabled: z.boolean().optional(),
    reminderOffsets: reminderOffsetsSchema.optional(),
    name: z.string().min(1).max(200).optional(),
    businessType: businessTypeSchema.optional(),
    // Sparse like the rest. Sticky by intent — changing accounting method with
    // the IRS requires Form 3115, so Settings presents this as a one-time
    // answer, not a toggle users flip per report.
    accountingMethod: accountingMethodSchema.optional(),
    // Sparse like the rest. Sticky by intent for the same reason as
    // accountingMethod: changing it mid-life leaves years already posted on the
    // old convention (the ledger is append-only), so Settings presents it as an
    // accountant's one-time correction rather than a toggle.
    depreciationConvention: depreciationConventionSchema.optional(),
    vehicleExpenseMethod: vehicleExpenseMethodSchema.optional(),
    // Sparse like the rest. No null case: the column is NOT NULL, and "no
    // timezone" is spelled 'UTC'.
    timezone: timezoneSchema.optional(),
    replyToEmail: nullableEmailField,
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
    // Customer-facing business email for the invoice "from" block. Nullable on
    // the wire like replyToEmail: '' clears it, a valid email sets it,
    // `undefined` leaves it alone. Validated as an email (unlike address/phone)
    // since it's a single structured value.
    businessEmail: nullableEmailField,
    // Per-field defaults for whether each contact detail prints on invoices.
    // Plain optional booleans (sparse: omitted → leave alone).
    showAddressOnInvoice: z.boolean().optional(),
    showPhoneOnInvoice: z.boolean().optional(),
    showEmailOnInvoice: z.boolean().optional(),
    // The estimate-side equivalents (separate document-type defaults).
    showAddressOnEstimate: z.boolean().optional(),
    showPhoneOnEstimate: z.boolean().optional(),
    showEmailOnEstimate: z.boolean().optional(),
  })
  // Sparse: at least one field must be present (zod only surfaces keys that
  // were actually sent, so an empty body fails this).
  .refine((v) => Object.keys(v).length > 0, {
    message: 'Change at least one thing before saving.',
  });

export type CompanyUpdateInput = z.infer<typeof companyUpdateSchema>;

// Input for POST /api/companies — adding another business to an existing
// workspace (the first company is seeded at signup). Both fields required, so
// the new company starts fully named + typed and never trips the first-run
// gate. Optional identity/payment fields are intentionally NOT here: keep
// creation a two-field decision, then the operator fills the rest from settings
// (or the create flow can PATCH them after). businessType is required here
// precisely because the server seeds the matching chart of accounts in the same
// transaction — unlike signup, this path knows the answer up front.
export const companyCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  businessType: businessTypeSchema,
});

export type CompanyCreateInput = z.infer<typeof companyCreateSchema>;

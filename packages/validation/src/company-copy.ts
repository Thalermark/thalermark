import { z } from 'zod';

// Copying one company's setup into another — the reference data and settings a
// business carries with it, without any of its history.
//
// The split is not arbitrary. Contacts, price list, tax rates, email wording and
// business identity describe how a business OPERATES, and survive it becoming a
// different legal entity. Invoices, expenses, bills and journal entries describe
// what a particular taxpayer DID, and belong to that taxpayer forever — moving
// them would restate one business's history as another's. So this copies the
// former and never the latter, which is also exactly the line the CSV importer
// already draws ("only the two ledger-free entities").

// What to bring across. Every flag is optional on the wire and ON when omitted —
// the caller is normally cloning a whole setup, and the flags exist so a wizard
// can offer them as checkboxes.
//
// Deliberately NOT expressed with per-field `.default(true)`. Zod's `.default()`
// short-circuits: an omitted `include` object would come back as a bare `{}`
// with none of the inner defaults applied, so every flag would read as falsy and
// a copy would silently do nothing. `resolveCopyInclude` is the single place the
// "on unless told otherwise" rule lives.
export const companyCopyIncludeSchema = z.object({
  taxPolicies: z.boolean().optional(),
  items: z.boolean().optional(),
  contacts: z.boolean().optional(),
  recurringInvoices: z.boolean().optional(),
  emailTemplates: z.boolean().optional(),
  // Address, phone, email, the show-on-invoice defaults, timezone, accounting
  // method, depreciation convention, offline payment instructions.
  profile: z.boolean().optional(),
  // The logo, which is an object-storage copy rather than a row copy.
  branding: z.boolean().optional(),
});

export type CompanyCopyIncludeInput = z.infer<typeof companyCopyIncludeSchema>;

// Every flag resolved — what the engine actually reads.
export type CompanyCopyInclude = Required<CompanyCopyIncludeInput>;

export function resolveCopyInclude(input: CompanyCopyIncludeInput | undefined): CompanyCopyInclude {
  const on = (v: boolean | undefined) => v !== false;
  return {
    taxPolicies: on(input?.taxPolicies),
    items: on(input?.items),
    contacts: on(input?.contacts),
    recurringInvoices: on(input?.recurringInvoices),
    emailTemplates: on(input?.emailTemplates),
    profile: on(input?.profile),
    branding: on(input?.branding),
  };
}

export const companyCopyRequestSchema = z.object({
  // The company to copy FROM. The target is the :id in the path, so the request
  // reads "make this company look like that one".
  sourceCompanyId: z.string().uuid(),
  include: companyCopyIncludeSchema.optional(),
});

export type CompanyCopyRequest = z.infer<typeof companyCopyRequestSchema>;

// Per-entity counts, so a caller can say "42 contacts, 12 items" without
// re-querying. `logo` is a boolean because there is at most one.
export type CompanyCopyResult = {
  taxPolicies: number;
  items: number;
  contacts: number;
  recurringInvoices: number;
  emailTemplates: number;
  logo: boolean;
  profile: boolean;
};

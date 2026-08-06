import { z } from 'zod';
import { lineItemType } from './item.js';
import { isoDateString, moneyString, priceString, quantityString, taxRateString } from './money.js';

// Per-line input. position is the 1-based ordinal the UI uses to render the
// rows; the server trusts what the client sent rather than re-sequencing,
// so reordered drafts round-trip cleanly. amount duplicates quantity * unit
// price — the client computes it (with whatever rounding rule it chose) and
// the server records that exact value; the schema does not re-derive.
export const invoiceLineItemInputSchema = z.object({
  position: z.number().int().min(1).max(10_000),
  description: z.string().min(1).max(500),
  quantity: quantityString,
  unitPrice: priceString,
  amount: moneyString,
  // Unit-of-measure snapshot ("hour", "sq ft") shown next to the quantity on
  // the sent/public document. Copied from the picked catalog item's unitLabel
  // or hand-typed; optional — omitted / null lines render a bare quantity.
  unitLabel: z.string().max(50).optional(),
  // product | service snapshot, copied from the catalog item on pick. Optional
  // — the DB defaults to 'service'. Drives the ledger revenue split. The server
  // sums product-line amounts at posting to route them to Product Revenue.
  type: lineItemType.optional(),
  // Per-line tax snapshot. taxable gates whether the line is taxed; taxRatePct
  // is the applied policy's rate (percent string); taxAmount is the computed
  // line tax (taxOfAmount(amount, taxRatePct)). All optional — the DB defaults
  // them to false / '0' / '0'. Like the money fields, the client computes and
  // the server stores as-sent (no re-derivation). The invoice header `tax` is
  // the sum of these line taxAmounts. taxPolicyId is a provenance breadcrumb.
  taxable: z.boolean().optional(),
  taxRatePct: taxRateString.optional(),
  taxAmount: moneyString.optional(),
  taxPolicyId: z.string().uuid().optional(),
  // Reporting breadcrumb back to the catalog item this line was picked from
  // (omitted for hand-typed lines). The stored/displayed values are always
  // the snapshot above — this is provenance only, never re-read.
  sourceItemId: z.string().uuid().optional(),
  // The tracked time entry this line bills (TMC-180), omitted for every other
  // line. THE LINE is the single source of truth for what an invoice bills:
  // the server derives which entries to stamp from the submitted lines, so
  // deleting a line releases its entry with no extra bookkeeping.
  //
  // This replaced a separate billedTimeEntryIds array on the invoice payload.
  // Two sources of truth meant a form could submit lines and ids that disagreed
  // — and the edit form had to ship hidden already-billed ids to avoid
  // releasing entries it still billed for, because a saved hour line had no
  // back-link to follow.
  timeEntryId: z.string().uuid().optional(),
});

export type InvoiceLineItemInput = z.infer<typeof invoiceLineItemInputSchema>;

// Input schema for POST /api/invoices. accountId is inferred from
// rls-context. number is required from the client in this slice — auto-
// numbering is a UX decision that lands with the invoice-create UI slice.
//
// Money math (subtotal = sum(line amounts), total = subtotal + tax) is
// performed client-side and stored as-sent. The server validates each
// field's decimal shape (see money.ts) but does not re-derive — that keeps
// the wire format symmetric across web/mobile and avoids subtle FP rounding
// drift between client display and DB-stored values.
export const invoiceCreateSchema = z.object({
  companyId: z.string().uuid(),
  contactId: z.string().uuid(),
  number: z.string().min(1).max(50),
  issueDate: isoDateString,
  dueDate: isoDateString,
  currency: z.string().length(3).optional(), // server defaults to 'USD'
  subtotal: moneyString,
  tax: moneyString.optional(),
  total: moneyString,
  notes: z.string().max(5000).optional(),
  // Per-invoice "show this in the public from-block" flags for the company's
  // address / phone / email. Optional: when omitted the server seeds them from
  // the company's show_*_on_invoice defaults (so a client that doesn't render
  // the toggles still gets the operator's chosen default). The edit form sends
  // them explicitly. Inherited by invoiceUpdateSchema below.
  showAddress: z.boolean().optional(),
  showPhone: z.boolean().optional(),
  showEmail: z.boolean().optional(),
  lineItems: z.array(invoiceLineItemInputSchema).min(1).max(200),
  // Optional membership in a job (TMC-181). Null detaches.
  //
  // Which tracked hours this invoice bills is NOT a field here — it is derived
  // from lineItems[].timeEntryId. Billing hours is deliberately not a server
  // endpoint that appends lines and recomputes totals: money math is
  // client-side and stored as-sent, so a server-side appender would be a second
  // totals path free to disagree with the first. The client builds the hour
  // lines with the same helpers every other line uses; the server reads their
  // timeEntryId, validates each one (same account, company and job, and not
  // already billed elsewhere) and stamps them in the same transaction.
  jobId: z.string().uuid().nullable().optional(),
});

export type InvoiceCreateInput = z.infer<typeof invoiceCreateSchema>;

// Input schema for PATCH /api/invoices/:id. Same shape as create minus
// companyId — an invoice cannot move between companies (the
// (company_id, number) uniqueness is scoped to that company, and the
// contact↔company invariant the create endpoint enforces would break).
// contactId stays mutable: a user can reassign a draft invoice to a
// different contact in the same company. line items submitted on PATCH
// replace the existing set wholesale (delete + insert in one tx); the
// schema mirrors create rather than supporting partial line-item edits,
// because partial-line-item semantics get hairy fast (renumber? merge?
// preserve ids?) and full-replacement is what the edit form sends anyway.
export const invoiceUpdateSchema = invoiceCreateSchema.omit({ companyId: true });

export type InvoiceUpdateInput = z.infer<typeof invoiceUpdateSchema>;

// Input schema for POST /api/invoices/:id/send. `to` is an optional
// recipient override — defaults to the contact's email server-side. Empty
// body (no override) is valid and the schema reflects that with an
// optional everything object.
export const invoiceSendSchema = z.object({
  to: z.string().email().optional(),
});

export type InvoiceSendInput = z.infer<typeof invoiceSendSchema>;

// Input schema for POST /api/invoices/:id/mark-paid. Records HOW the money
// arrived. The picker offers every offline channel unconditionally — what a
// business advertises on its invoice (the company offline-method settings) is
// separate from what it will accept in hand. 'stripe' is deliberately NOT in
// this set: it's stamped server-side by the payment_intent.succeeded webhook,
// never user-submitted. reference is an optional note (check number,
// confirmation code); '' coerces to null so a blank field clears cleanly.
export const INVOICE_PAYMENT_METHODS = ['cash', 'check', 'venmo', 'zelle', 'other'] as const;

export const invoiceMarkPaidSchema = z.object({
  method: z.enum(INVOICE_PAYMENT_METHODS),
  reference: z
    .union([z.string().trim().max(100), z.literal(''), z.null()])
    .transform((v) => (v ? v : null))
    .optional(),
  // Date the payment was actually received (offline payments are often
  // recorded days later). Drives paidAt + the ledger posting date. Omitted →
  // server uses now. Format-only validation, like issue/due dates; the UI caps
  // it at today.
  paidOn: isoDateString.optional(),
});

export type InvoiceMarkPaidInput = z.infer<typeof invoiceMarkPaidSchema>;

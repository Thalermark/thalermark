import { z } from 'zod';
import { lineItemType } from './item.js';
import { isoDateString, moneyString, quantityString, taxRateString } from './money.js';

// Template line item — identical shape to invoiceLineItemInputSchema; the
// sweeper clones these verbatim onto each generated invoice.
export const recurringInvoiceLineItemInputSchema = z.object({
  position: z.number().int().min(1).max(10_000),
  description: z.string().min(1).max(500),
  quantity: quantityString,
  unitPrice: moneyString,
  amount: moneyString,
  // product | service snapshot — cloned verbatim onto each generated invoice
  // line by the sweeper. See invoiceLineItemInputSchema for the contract.
  type: lineItemType.optional(),
  // Per-line tax snapshot — see invoiceLineItemInputSchema. Cloned verbatim
  // onto each generated invoice line by the sweeper.
  taxable: z.boolean().optional(),
  taxRatePct: taxRateString.optional(),
  taxAmount: moneyString.optional(),
  taxPolicyId: z.string().uuid().optional(),
  // Reporting breadcrumb back to the catalog item (omitted for hand-typed
  // lines). Cloned verbatim onto each generated invoice line by the sweeper.
  sourceItemId: z.string().uuid().optional(),
});

export type RecurringInvoiceLineItemInput = z.infer<typeof recurringInvoiceLineItemInputSchema>;

// Cadence: weekly / monthly / yearly × an "every N" interval. Matches the
// frequency CHECK constraint in migration 0033.
export const recurringFrequencySchema = z.enum(['weekly', 'monthly', 'yearly']);
export type RecurringFrequency = z.infer<typeof recurringFrequencySchema>;

// Input schema for POST /api/recurring-invoices. Mirrors invoiceCreateSchema's
// "client computes money, server stores as-sent" contract (no re-derivation
// server-side). A schedule has no number / issue date / due date — those are
// minted per generated invoice; startDate is the first occurrence and seeds
// next_run_date server-side.
//
// End conditions are independent and both optional: endDate and maxOccurrences
// may each be set, neither, or both (whichever is reached first ends the
// schedule). netTermsDays drives the generated invoice's due date and defaults
// to Net-30 server-side when omitted.
export const recurringInvoiceCreateSchema = z.object({
  companyId: z.string().uuid(),
  customerId: z.string().uuid(),
  frequency: recurringFrequencySchema,
  intervalCount: z.number().int().min(1).max(365),
  startDate: isoDateString,
  endDate: isoDateString.optional(),
  maxOccurrences: z.number().int().min(1).max(10_000).optional(),
  netTermsDays: z.number().int().min(0).max(365).optional(), // server defaults to 30
  currency: z.string().length(3).optional(), // server defaults to 'USD'
  subtotal: moneyString,
  tax: moneyString.optional(),
  total: moneyString,
  notes: z.string().max(5000).optional(),
  lineItems: z.array(recurringInvoiceLineItemInputSchema).min(1).max(200),
});

export type RecurringInvoiceCreateInput = z.infer<typeof recurringInvoiceCreateSchema>;

// Input schema for PATCH /api/recurring-invoices/:id. Same as create minus
// companyId — a schedule cannot move between companies (its generated invoices
// inherit the (company_id, number) sequence). status changes go through the
// dedicated pause/resume/end endpoints, not PATCH. Line items replace the
// existing set wholesale, mirroring invoiceUpdateSchema.
export const recurringInvoiceUpdateSchema = recurringInvoiceCreateSchema.omit({ companyId: true });

export type RecurringInvoiceUpdateInput = z.infer<typeof recurringInvoiceUpdateSchema>;

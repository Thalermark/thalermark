import { z } from 'zod';
import { isoDateString, moneyString, quantityString } from './money.js';

// Per-line input for estimates. Identical shape to invoice line items —
// position is 1-based, amount duplicates quantity * unit_price (client
// computes, server stores as-sent). Kept as a separate schema rather than
// re-exporting the invoice one so estimate-specific evolution (e.g. an
// "optional" flag for proposed-but-not-included add-ons) stays additive.
export const estimateLineItemInputSchema = z.object({
  position: z.number().int().min(1).max(10_000),
  description: z.string().min(1).max(500),
  quantity: quantityString,
  unitPrice: moneyString,
  amount: moneyString,
});

export type EstimateLineItemInput = z.infer<typeof estimateLineItemInputSchema>;

// Input schema for POST /api/estimates. Mirrors invoiceCreateSchema with two
// differences: no dueDate (estimates aren't a debt), and an optional
// expiresOn (the quote-validity date — advisory-at-read, no background
// expiry job in MVP). Client-side math + server-stores-as-sent invariant
// from invoices carries over.
export const estimateCreateSchema = z.object({
  companyId: z.string().uuid(),
  customerId: z.string().uuid(),
  number: z.string().min(1).max(50),
  issueDate: isoDateString,
  expiresOn: isoDateString.optional(),
  currency: z.string().length(3).optional(), // server defaults to 'USD'
  subtotal: moneyString,
  tax: moneyString.optional(),
  total: moneyString,
  notes: z.string().max(5000).optional(),
  lineItems: z.array(estimateLineItemInputSchema).min(1).max(200),
});

export type EstimateCreateInput = z.infer<typeof estimateCreateSchema>;

// PATCH /api/estimates/:id. Same pattern as invoiceUpdateSchema — companyId
// is intentionally immutable (the (company_id, number) uniqueness scope and
// customer↔company invariant would break on a move). customerId stays
// mutable so a draft can be reassigned within the company.
export const estimateUpdateSchema = estimateCreateSchema.omit({ companyId: true });

export type EstimateUpdateInput = z.infer<typeof estimateUpdateSchema>;

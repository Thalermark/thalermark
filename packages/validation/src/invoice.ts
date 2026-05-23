import { z } from 'zod';
import { isoDateString, moneyString, quantityString } from './money.js';

// Per-line input. position is the 1-based ordinal the UI uses to render the
// rows; the server trusts what the client sent rather than re-sequencing,
// so reordered drafts round-trip cleanly. amount duplicates quantity * unit
// price — the client computes it (with whatever rounding rule it chose) and
// the server records that exact value; the schema does not re-derive.
export const invoiceLineItemInputSchema = z.object({
  position: z.number().int().min(1).max(10_000),
  description: z.string().min(1).max(500),
  quantity: quantityString,
  unitPrice: moneyString,
  amount: moneyString,
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
  customerId: z.string().uuid(),
  number: z.string().min(1).max(50),
  issueDate: isoDateString,
  dueDate: isoDateString,
  currency: z.string().length(3).optional(), // server defaults to 'USD'
  subtotal: moneyString,
  tax: moneyString.optional(),
  total: moneyString,
  notes: z.string().max(5000).optional(),
  lineItems: z.array(invoiceLineItemInputSchema).min(1).max(200),
});

export type InvoiceCreateInput = z.infer<typeof invoiceCreateSchema>;

import { z } from 'zod';
import { isoDateString, moneyString, signedMoneyString } from './money.js';

// Vendor bills — accounts payable. A bill is the accrual sibling of an expense:
// it recognises a cost you owe now (Dr <category> / Cr Accounts Payable) and is
// settled later (Dr Accounts Payable / Cr <payment asset>). The double-entry is
// hidden — the client only ever talks about a vendor, a category, an amount, and
// dates. accountId is inferred from the rls-context middleware (x-account-id);
// the client supplies the company scope and the visible fields.
//
// contactId is required — a bill is always owed to someone (a contact acting as
// vendor; the API marks it is_vendor on link, same as the expense vendor field).
// categoryAccountId is a chart_of_accounts row UUID (not a code) the cost lands
// in; the API resolves it to its code and validates account_type === 'expense'
// before posting. There is no paymentAccountId at create — a bill is recorded
// 'open' (unpaid); the asset it's paid from is chosen on mark-paid. amount is a
// decimal string ([[architecture_money_decimal_strings]]) for the full total
// owed (purchase sales tax rolls into the cost for the cash-basis sole-prop
// audience — no separate tax field, matching the expense entity). billDate /
// dueDate are bare YYYY-MM-DD calendar dates. reference is the vendor's own bill
// number (free text, optional). memo is the user's note.
export const billCreateSchema = z.object({
  companyId: z.string().uuid(),
  contactId: z.string().uuid(),
  categoryAccountId: z.string().uuid(),
  amount: moneyString,
  billDate: isoDateString,
  dueDate: isoDateString,
  currency: z.string().length(3).optional(), // server defaults to 'USD'
  reference: z.string().max(100).optional(),
  memo: z.string().max(5000).optional(),
});

export type BillCreateInput = z.infer<typeof billCreateSchema>;

// Input schema for PATCH /api/bills/:id. Sparse like expenseUpdateSchema: the
// edit form may touch one field. companyId is omitted — a bill cannot move
// between companies (its ledger accounts are company-scoped, so a move would
// orphan the posting). At least one field must be present. Editing an open bill
// is a full reversal of the prior open posting + a fresh posting in one tx (no
// amend-in-place); paid/voided bills are immutable and the API rejects edits.
export const billUpdateSchema = billCreateSchema
  .omit({ companyId: true })
  .partial()
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'at_least_one_field_required',
  });

export type BillUpdateInput = z.infer<typeof billUpdateSchema>;

// Input schema for POST /api/bills/:id/mark-paid. Records HOW the bill was
// settled and from WHICH asset. Methods are the offline channels money leaves
// by — 'stripe' is deliberately absent (you don't pay a vendor through your own
// Stripe). paymentAccountId is the asset the payment came from (a
// chart_of_accounts 'asset' row); omitted → the server defaults to Cash (1000),
// matching the single-Cash MVP seed. reference is an optional note (check
// number, confirmation code); '' coerces to null. paidOn is the date the
// payment actually left (drives paidAt + the ledger posting date); omitted →
// server uses now.
export const BILL_PAYMENT_METHODS = ['cash', 'check', 'venmo', 'zelle', 'other'] as const;
export type BillPaymentMethod = (typeof BILL_PAYMENT_METHODS)[number];

export const billMarkPaidSchema = z.object({
  method: z.enum(BILL_PAYMENT_METHODS),
  paymentAccountId: z.string().uuid().optional(),
  reference: z
    .union([z.string().trim().max(100), z.literal(''), z.null()])
    .transform((v) => (v ? v : null))
    .optional(),
  paidOn: isoDateString.optional(),
});

export type BillMarkPaidInput = z.infer<typeof billMarkPaidSchema>;

// Input schema for POST /api/bills/:id/payments (TMC-192) — one payment against
// a bill, the accounts-payable mirror of invoicePaymentCreateSchema.
//
// mark-paid above is now the special case of this (a payment for the whole
// balance) rather than the only way money can leave, and is left exactly as it
// was so the quick path and every existing caller are untouched.
//
// amount is SIGNED: positive is money out to the vendor, negative is a refund
// back from them. paidOn is required here where mark-paid defaults it — a
// payment list with a blank date is unreadable, and the client always knows.
//
// paymentAccountId is the asset this particular payment left from, resolved to
// the company's Cash (1000) when omitted. It is per-payment rather than
// per-bill on purpose: paying half from the business account and half in cash
// is the case partial payments exist for.
export const billPaymentCreateSchema = z.object({
  amount: signedMoneyString,
  paidOn: isoDateString,
  method: z.enum(BILL_PAYMENT_METHODS),
  paymentAccountId: z.string().uuid().optional(),
  reference: z
    .union([z.string().trim().max(100), z.literal(''), z.null()])
    .transform((v) => (v ? v : null))
    .optional(),
  // Double-click protection (TMC-218), the mirror of the field on
  // invoicePaymentCreateSchema — a bounded opaque string the server never
  // parses, only compares. See the long note there for why it is not a UUID and
  // why '' coerces to absent. Optional, so every existing caller is untouched.
  //
  // The invoice side inherited an idempotency guarantee from Stripe and only
  // ever lacked one on the manual path. There is no Stripe leg here at all — a
  // bill is money you pay OUT — so this field is the only thing standing between
  // a double-click and paying a vendor twice on the books.
  idempotencyKey: z
    .union([z.string().trim().min(8).max(200), z.literal(''), z.null()])
    .transform((v) => (v ? v : undefined))
    .optional(),
});

export type BillPaymentCreateInput = z.infer<typeof billPaymentCreateSchema>;

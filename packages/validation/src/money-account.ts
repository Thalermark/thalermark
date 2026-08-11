import { z } from 'zod';

// Money accounts — the places a business's money actually sits (TMC-207).
//
// These are rows in the chart of accounts, but the user is never told that. They
// add "Chase Business Checking" and pick what kind of thing it is; the system
// decides that checking is an asset and a card is a liability, allocates the
// account code, and keeps the double entry to itself. That split is the whole
// hidden-ledger thesis: the earlier draft of this ticket excluded credit cards
// *because* a card is a liability, which is the system handing the user its own
// homework.
//
// 'cash' is money in hand — a till, a cash box, an envelope in the truck. It is
// also the kind the seeded account carries, so a company that never touches this
// feature keeps behaving exactly as it did.
export const moneyAccountKind = z.enum(['checking', 'savings', 'cash', 'credit_card']);

export type MoneyAccountKind = z.infer<typeof moneyAccountKind>;

// Kinds whose balance is money the business HOLDS. A credit card is money it
// OWES, so it is spendable-from but never counted as cash on hand — summing it
// in would report a business as richer the more it borrowed. The ledger's
// CASH_ON_HAND_KINDS is the server-side twin of this.
export const CASH_ON_HAND_KINDS = ['checking', 'savings', 'cash'] as const;

// Input for POST /api/money-accounts. accountId comes from rls-context.
//
// There is deliberately no opening-balance field. Two paths for injecting a
// starting figure would be two sources of truth for the same equity, and this
// codebase already has one: the conversion trial balance (migration 0021) for a
// business arriving with real books, and an owner contribution for money the
// owner puts in. Recording what is already in a new account goes through those,
// now that an owner money event can name the account it landed in.
export const moneyAccountCreateSchema = z.object({
  companyId: z.string().uuid(),
  name: z.string().min(1, 'Give this account a name.').max(200),
  kind: moneyAccountKind,
});

export type MoneyAccountCreateInput = z.infer<typeof moneyAccountCreateSchema>;

// Input for PATCH /api/money-accounts/:id.
//
// Name only. The KIND is fixed after creation on purpose: it decides whether the
// account is an asset or a liability, and flipping that on an account with
// postings against it would silently move money between the two halves of the
// balance sheet without a single journal entry recording that it happened.
// Someone who picked wrong archives it and adds the right one.
//
// The code is never settable — the ledger posts by literal code, so a renumber
// would orphan every entry already pointing at it.
export const moneyAccountUpdateSchema = z.object({
  name: z.string().min(1, 'Give this account a name.').max(200),
});

export type MoneyAccountUpdateInput = z.infer<typeof moneyAccountUpdateSchema>;

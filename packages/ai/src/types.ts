import type { LlmCredential } from './provider.js';

// Receipt extraction (slice 8.9h). Pro+/BYOK vision-LLM auto-fill: given a
// receipt image (or PDF, rendered to an image first) the extractor reads back
// the merchant, total, date, tax, and a suggested expense category — the user
// reviews and saves, the AI never writes the ledger directly.
//
// The interface is intentionally provider-agnostic and dependency-light at the
// call site: the api depends on this shape, not on the Vercel AI SDK, so the
// extract route stays testable with a plain stub (no live model in tests),
// matching the stripe/storage/mailer opt-in pattern. Each call takes the
// LlmCredential to run under — resolved per account by the api (managed or a
// tenant's BYOK key) rather than bound to one global key at boot.

// One allowed category the model may suggest, scoped to the company's expense
// chart of accounts. The model is constrained to these codes (both in the
// prompt and by post-hoc validation) so it can't invent a code that doesn't
// post.
export interface ExpenseCategoryOption {
  code: string;
  name: string;
}

export interface ExtractionInput {
  // Raw receipt bytes as stored. The extractor handles PDF → image rendering
  // internally so every provider (including image-only ones like Ollama) gets
  // a uniform image input.
  bytes: Uint8Array;
  // 'image/jpeg' | 'image/png' | 'application/pdf' — the receipt-capture
  // allowlist from slice 8.9g.
  mimeType: string;
  allowedCategories: ExpenseCategoryOption[];
}

// Every field is nullable — the model returns null for anything it can't read
// off the receipt rather than guessing. Money fields are decimal strings to
// match the on-the-wire money convention ([[architecture_money_decimal_strings]]);
// expenseDate is YYYY-MM-DD; suggestedCategoryCode is one of the input codes
// or null.
export interface ExtractionResult {
  merchant: string | null;
  total: string | null;
  expenseDate: string | null;
  taxAmount: string | null;
  suggestedCategoryCode: string | null;
}

export interface ReceiptExtractor {
  extractReceipt(input: ExtractionInput, credential: LlmCredential): Promise<ExtractionResult>;
}

// Text-based expense categorization. The complement to receipt extraction's
// category suggestion: given the visible fields a user typed for a manual
// expense (no image), suggest one expense-COA code. Text-only so it runs on any
// model, including a text-only local Ollama. The user reviews + saves; the AI
// never writes the ledger directly.
export interface CategorizeInput {
  merchant: string;
  // The user's note and the amount, when present — extra signal for the
  // suggestion. amount is a decimal string ([[architecture_money_decimal_strings]]).
  memo?: string | null;
  amount?: string | null;
  allowedCategories: ExpenseCategoryOption[];
}

// suggestedCategoryCode is one of the input codes or null — the model returns
// null rather than guessing when nothing fits, and any code outside the input
// list is nulled by post-hoc validation.
export interface CategorizeResult {
  suggestedCategoryCode: string | null;
}

export interface ExpenseCategorizer {
  categorize(input: CategorizeInput, credential: LlmCredential): Promise<CategorizeResult>;
}

// Cash-flow nudges (AI insight). Deterministic ledger figures are computed by
// the API (the LLM must never do arithmetic on a ledger); the reasoning-role
// model only turns them into short plain-English nudges. All money fields are
// decimal strings ([[architecture_money_decimal_strings]]).
export interface CashFlowSignals {
  asOf: string; // YYYY-MM-DD
  cashOnHand: string;
  monthToDate: { moneyIn: string; moneyOut: string };
  // Recent full calendar months, oldest first (for trend / seasonality). Empty
  // for a brand-new account with no prior months on record.
  trailingMonths: { month: string; moneyIn: string; moneyOut: string }[]; // month: YYYY-MM
  owed: string;
  overdueCount: number;
}

// One nudge. tone drives styling: good (reassuring), warning (needs attention —
// low cash, overdue, rising spend), info (neutral observation).
export interface CashFlowNudge {
  text: string;
  tone: 'good' | 'warning' | 'info';
}

export interface CashFlowAdvisor {
  // Returns up to ~3 nudges; an empty array when there's too little to say.
  advise(signals: CashFlowSignals, credential: LlmCredential): Promise<CashFlowNudge[]>;
}

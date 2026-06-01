// Receipt extraction (slice 8.9h). Pro+/BYOK vision-LLM auto-fill: given a
// receipt image (or PDF, rendered to an image first) the extractor reads back
// the merchant, total, date, tax, and a suggested expense category — the user
// reviews and saves, the AI never writes the ledger directly.
//
// The interface is intentionally provider-agnostic and dependency-light at the
// call site: the api depends on this shape, not on the Vercel AI SDK, so the
// extract route stays testable with a plain stub (no live model in tests),
// matching the stripe/storage/mailer opt-in pattern.

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
  extractReceipt(input: ExtractionInput): Promise<ExtractionResult>;
}

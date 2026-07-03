import { generateObject } from 'ai';
import { z } from 'zod';
import { type RawExtraction, normalizeExtraction } from './normalize.js';
import { renderPdfFirstPageToPng } from './pdf.js';
import { type LlmCredential, resolveModel } from './provider.js';
import type { ExtractionInput, ExtractionResult, ReceiptExtractor } from './types.js';

// What the model is asked to emit. Money as numbers (models emit JSON numbers
// more reliably than pre-formatted strings); normalizeExtraction formats them.
const rawSchema = z.object({
  merchant: z.string().nullable().describe('Merchant / vendor name as printed'),
  total: z.number().nullable().describe('Grand total paid, in dollars'),
  expenseDate: z.string().nullable().describe('Date on the receipt as YYYY-MM-DD'),
  taxAmount: z.number().nullable().describe('Sales tax portion, in dollars, if shown'),
  suggestedCategoryCode: z
    .string()
    .nullable()
    .describe('One expense category code from the provided list, or null'),
});

function buildPrompt(allowed: ExtractionInput['allowedCategories']): string {
  const list = allowed.map((c) => `  ${c.code} — ${c.name}`).join('\n');
  return [
    'You are reading a receipt to help a self-employed tradesperson log an expense.',
    'Extract the fields from the receipt image. Use null for anything not clearly legible — do not guess.',
    'For suggestedCategoryCode, pick the single best-fitting code from this list (or null if none fit):',
    list,
    'Return the category code exactly as listed; never invent a code.',
  ].join('\n');
}

// Build a receipt extractor. Stateless: the vision model is resolved per call
// from the credential the api passes (managed or a tenant's BYOK key), so one
// process serves many accounts' keys. Whether AI is available for a given
// account is decided upstream by the credential resolver (a null credential
// 503s the route); a credential that reaches extractReceipt is expected to
// resolve, so a null model here is a misconfiguration.
export function createReceiptExtractor(): ReceiptExtractor {
  return {
    async extractReceipt(
      input: ExtractionInput,
      credential: LlmCredential,
    ): Promise<ExtractionResult> {
      const model = resolveModel(credential, 'vision');
      if (!model) throw new Error('no vision model for the provided LLM credential');

      // PDFs render to PNG first so every provider gets an image; images pass
      // through untouched.
      const image =
        input.mimeType === 'application/pdf'
          ? await renderPdfFirstPageToPng(input.bytes)
          : input.bytes;

      const { object } = await generateObject({
        model,
        schema: rawSchema,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: buildPrompt(input.allowedCategories) },
              { type: 'image', image },
            ],
          },
        ],
      });

      return normalizeExtraction(
        object as RawExtraction,
        input.allowedCategories.map((c) => c.code),
      );
    },
  };
}

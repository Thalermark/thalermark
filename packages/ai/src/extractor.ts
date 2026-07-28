import { generateObject } from 'ai';
import { z } from 'zod';
import { type RawExtraction, normalizeExtraction } from './normalize.js';
import { renderPdfFirstPageToPng } from './pdf.js';
import { businessPersona } from './persona.js';
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

function buildPrompt(input: ExtractionInput): string {
  const list = input.allowedCategories.map((c) => `  ${c.code} — ${c.name}`).join('\n');
  return [
    // The persona sits at the END of this sentence, unlike the original
    // "help a <persona> log an expense". The phrases carry a trailing
    // qualifier ("a small business set up as an S-corporation"), and mid-sentence
    // that garden-paths: "help a small business set up as an S-corporation log
    // an expense". The trailing slot is also what lets all three prompts in this
    // package share one set of phrases.
    `You are reading a receipt to help log an expense for ${businessPersona(input.businessType)}.`,
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
              { type: 'text', text: buildPrompt(input) },
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

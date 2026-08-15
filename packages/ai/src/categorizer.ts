import { generateObject } from 'ai';
import { z } from 'zod';
import { AI_MAX_RETRIES, CATEGORIZE_TIMEOUT_MS } from './limits.js';
import { constrainCode } from './normalize.js';
import { businessPersona } from './persona.js';
import { type LlmCredential, resolveModel } from './provider.js';
import type { CategorizeInput, CategorizeResult, ExpenseCategorizer } from './types.js';

// Text categorization is a fast/cheap task — it uses the 'fast' model role
// (Haiku on Anthropic, llama3.2 on Ollama), not the vision model extraction
// uses.
const schema = z.object({
  suggestedCategoryCode: z
    .string()
    .nullable()
    .describe('One expense category code from the provided list, or null if none fit'),
});

function buildPrompt(input: CategorizeInput): string {
  const list = input.allowedCategories.map((c) => `  ${c.code} — ${c.name}`).join('\n');
  const details = [
    // "Vendor" rather than "Merchant" on purpose: the COA can contain a
    // category named "Merchant Processing Fees", and a small model anchors on
    // the lexical overlap with a "Merchant:" label and mis-picks it.
    `Vendor: ${input.merchant}`,
    input.amount ? `Amount: ${input.amount}` : null,
    input.memo ? `Note: ${input.memo}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
  return [
    `You are categorizing a business expense for ${businessPersona(input.businessType)}.`,
    'Pick the single best-fitting expense category code from this list (or null if none clearly fit):',
    list,
    'Expense details:',
    details,
    'Return the category code exactly as listed; never invent a code.',
  ].join('\n');
}

// Build an expense categorizer. Stateless: the fast model is resolved per call
// from the credential the api passes, so one process serves many accounts'
// keys. AI availability for the account is decided upstream (a null credential
// 503s the route); a null model here is a misconfiguration. Same shape as the
// receipt extractor.
export function createExpenseCategorizer(): ExpenseCategorizer {
  return {
    async categorize(input: CategorizeInput, credential: LlmCredential): Promise<CategorizeResult> {
      const model = resolveModel(credential, 'fast');
      if (!model) throw new Error('no fast model for the provided LLM credential');

      const { object } = await generateObject({
        model,
        schema,
        messages: [{ role: 'user', content: buildPrompt(input) }],
        maxRetries: AI_MAX_RETRIES,
        abortSignal: AbortSignal.timeout(CATEGORIZE_TIMEOUT_MS),
      });
      return {
        suggestedCategoryCode: constrainCode(
          object.suggestedCategoryCode,
          input.allowedCategories.map((c) => c.code),
        ),
      };
    },
  };
}

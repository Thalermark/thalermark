import { generateObject } from 'ai';
import { z } from 'zod';
import { constrainCode } from './normalize.js';
import { type LlmEnv, resolveModel } from './provider.js';
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
    'You are categorizing a business expense for a self-employed tradesperson.',
    'Pick the single best-fitting expense category code from this list (or null if none clearly fit):',
    list,
    'Expense details:',
    details,
    'Return the category code exactly as listed; never invent a code.',
  ].join('\n');
}

// Build an expense categorizer from env, or null when no usable provider is
// configured (anthropic/openai with no LLM_API_KEY, or an unknown provider).
// The api treats null as "AI disabled" and 503s the categorize route — same
// opt-in model as the receipt extractor.
export function createExpenseCategorizer(env: LlmEnv): ExpenseCategorizer | null {
  const model = resolveModel(env, 'fast');
  if (!model) return null;

  return {
    async categorize(input: CategorizeInput): Promise<CategorizeResult> {
      const { object } = await generateObject({
        model,
        schema,
        messages: [{ role: 'user', content: buildPrompt(input) }],
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

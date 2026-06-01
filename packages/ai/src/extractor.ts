import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { type LanguageModel, generateObject } from 'ai';
import { z } from 'zod';
import { type RawExtraction, normalizeExtraction } from './normalize.js';
import { renderPdfFirstPageToPng } from './pdf.js';
import type { ExtractionInput, ExtractionResult, ReceiptExtractor } from './types.js';

// Env contract matches the committed .env.example "LLM (Vercel AI SDK)" block.
// LLM_API_KEY powers both extraction and (future) insights — no separate vendor
// for MVP. Anthropic Sonnet is the default vision model; the overrides let a
// self-hoster point at Haiku or a local Ollama model.
export interface ExtractorEnv {
  LLM_PROVIDER?: string;
  LLM_API_KEY?: string;
  LLM_MODEL_REASONING?: string;
  LLM_MODEL_FAST?: string;
  OLLAMA_BASE_URL?: string;
}

// Default vision-capable models per provider. Overridable via LLM_MODEL_REASONING.
const DEFAULT_MODELS = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4o',
  ollama: 'llama3.2-vision',
} as const;

// Resolve env → a Vercel AI SDK model, or null when the chosen provider can't
// run (anthropic/openai with no key). Ollama needs no key — it's the AGPL-pure
// self-host path — so it's always available once selected. An unknown provider
// returns null rather than throwing so a typo just disables the feature
// (endpoint 503s) instead of crashing boot.
function resolveModel(env: ExtractorEnv): LanguageModel | null {
  const provider = (env.LLM_PROVIDER ?? 'anthropic').trim().toLowerCase();
  const key = env.LLM_API_KEY?.trim();
  const model = env.LLM_MODEL_REASONING?.trim();

  if (provider === 'anthropic') {
    if (!key) return null;
    return createAnthropic({ apiKey: key })(model || DEFAULT_MODELS.anthropic);
  }
  if (provider === 'openai') {
    if (!key) return null;
    return createOpenAI({ apiKey: key })(model || DEFAULT_MODELS.openai);
  }
  if (provider === 'ollama') {
    const baseURL = `${(env.OLLAMA_BASE_URL ?? 'http://localhost:11434').trim().replace(/\/$/, '')}/v1`;
    // Ollama ignores the key but the OpenAI-compatible client requires one.
    return createOpenAICompatible({ name: 'ollama', baseURL, apiKey: key || 'ollama' })(
      model || DEFAULT_MODELS.ollama,
    );
  }
  return null;
}

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

// Build a receipt extractor from env, or null when no usable provider is
// configured. The api treats null as "AI disabled" and 503s the extract route —
// same opt-in model as stripe/storage.
export function createReceiptExtractor(env: ExtractorEnv): ReceiptExtractor | null {
  const model = resolveModel(env);
  if (!model) return null;

  return {
    async extractReceipt(input: ExtractionInput): Promise<ExtractionResult> {
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

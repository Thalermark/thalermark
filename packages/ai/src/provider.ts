import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

// Env contract matches the committed .env.example "LLM (Vercel AI SDK)" block.
// One LLM_API_KEY powers every AI feature — no separate vendor for MVP. The
// per-role model overrides let a self-hoster point each task at a different
// model; this matters mainly for Ollama, where vision and text are separate
// models (cloud Sonnet/Haiku are multimodal, so one model serves every role).
export interface LlmEnv {
  LLM_PROVIDER?: string;
  LLM_API_KEY?: string;
  LLM_MODEL_VISION?: string;
  LLM_MODEL_REASONING?: string;
  LLM_MODEL_FAST?: string;
  OLLAMA_BASE_URL?: string;
}

// Model roles, by task shape rather than vendor:
//   vision    — reads an image (receipt extraction)
//   reasoning — heavy text reasoning (reserved for later insight features)
//   fast      — cheap/quick text (expense categorization)
export type ModelRole = 'vision' | 'reasoning' | 'fast';

// Per-provider default model for each role. anthropic maps reasoning→Sonnet,
// fast→Haiku (the two-tier strategy in CLAUDE.md); vision reuses Sonnet since
// it's multimodal. ollama splits vision (llama3.2-vision) from text (llama3.2).
const DEFAULT_MODELS: Record<string, Record<ModelRole, string>> = {
  anthropic: {
    vision: 'claude-sonnet-4-6',
    reasoning: 'claude-sonnet-4-6',
    fast: 'claude-haiku-4-5',
  },
  openai: { vision: 'gpt-4o', reasoning: 'gpt-4o', fast: 'gpt-4o-mini' },
  ollama: { vision: 'llama3.2-vision', reasoning: 'llama3.2', fast: 'llama3.2' },
};

function overrideFor(env: LlmEnv, role: ModelRole): string | undefined {
  const raw =
    role === 'vision'
      ? env.LLM_MODEL_VISION
      : role === 'reasoning'
        ? env.LLM_MODEL_REASONING
        : env.LLM_MODEL_FAST;
  return raw?.trim() || undefined;
}

// Resolve env + role → a Vercel AI SDK model, or null when the chosen provider
// can't run (anthropic/openai with no key, or an unknown provider — a typo just
// disables the feature rather than crashing boot). Ollama needs no key (the
// AGPL-pure self-host path) so it's always available once selected.
export function resolveModel(env: LlmEnv, role: ModelRole): LanguageModel | null {
  const provider = (env.LLM_PROVIDER ?? 'anthropic').trim().toLowerCase();
  const defaults = DEFAULT_MODELS[provider];
  if (!defaults) return null;
  const key = env.LLM_API_KEY?.trim();
  const model = overrideFor(env, role) ?? defaults[role];

  if (provider === 'anthropic') {
    if (!key) return null;
    return createAnthropic({ apiKey: key })(model);
  }
  if (provider === 'openai') {
    if (!key) return null;
    return createOpenAI({ apiKey: key })(model);
  }
  // ollama — the only remaining provider with a defaults entry.
  const baseURL = `${(env.OLLAMA_BASE_URL ?? 'http://localhost:11434').trim().replace(/\/$/, '')}/v1`;
  // supportsStructuredOutputs: Ollama's /v1 honours response_format json_schema
  // (constrained decoding); without it the SDK won't send the schema and
  // generateObject falls back to flaky free-form JSON. apiKey is ignored by
  // Ollama but the OpenAI-compatible client requires a non-empty value.
  return createOpenAICompatible({
    name: 'ollama',
    baseURL,
    apiKey: key || 'ollama',
    supportsStructuredOutputs: true,
  })(model);
}

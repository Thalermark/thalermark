import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

// The LLM credential a single AI call runs under. On self-host it's one global
// credential (mapped from the LLM_* env, the same key for every account); on the
// managed platform it's resolved per account (a tenant's own BYOK key, or a
// managed key) — see apps/api/src/lib/llm-credentials.ts. The model is resolved
// per call from this bundle rather than bound at boot, which is what lets one
// process serve many accounts' keys. The per-role model overrides let a
// self-hoster point each task at a different model; this matters mainly for
// Ollama, where vision and text are separate models (cloud Sonnet/Haiku are
// multimodal, so one model serves every role).
export interface LlmCredential {
  provider?: string;
  apiKey?: string;
  modelVision?: string;
  modelReasoning?: string;
  modelFast?: string;
  ollamaBaseUrl?: string;
}

// Model roles, by task shape rather than vendor:
//   vision    — reads an image (receipt extraction)
//   reasoning — heavy text reasoning (cash-flow nudges)
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

function overrideFor(cred: LlmCredential, role: ModelRole): string | undefined {
  const raw =
    role === 'vision'
      ? cred.modelVision
      : role === 'reasoning'
        ? cred.modelReasoning
        : cred.modelFast;
  return raw?.trim() || undefined;
}

function providerOf(cred: LlmCredential): string {
  return (cred.provider ?? 'anthropic').trim().toLowerCase();
}

// Can this credential actually run a model? anthropic/openai need a key; ollama
// needs none (the AGPL-pure self-host path); an unknown provider (a typo)
// can't. Mirrors resolveModel's own null cases exactly, so a credential this
// returns true for always resolves to a model. The credential resolver
// (apps/api) uses it to decide "is AI available for this account?" without
// touching the SDK — a false answer 503s the route.
export function isCredentialUsable(cred: LlmCredential): boolean {
  const provider = providerOf(cred);
  if (provider === 'ollama') return true;
  if (provider === 'anthropic' || provider === 'openai') return Boolean(cred.apiKey?.trim());
  return false;
}

// Resolve a credential + role → a Vercel AI SDK model, or null when the
// credential can't run (see isCredentialUsable). Callers that pass a vetted
// credential (isCredentialUsable === true) can treat null as a misconfiguration.
export function resolveModel(cred: LlmCredential, role: ModelRole): LanguageModel | null {
  if (!isCredentialUsable(cred)) return null;
  const provider = providerOf(cred);
  const defaults = DEFAULT_MODELS[provider];
  // isCredentialUsable already rejected unknown providers; guard again for TS.
  if (!defaults) return null;
  const key = cred.apiKey?.trim();
  const model = overrideFor(cred, role) ?? defaults[role];

  if (provider === 'anthropic') {
    return createAnthropic({ apiKey: key })(model);
  }
  if (provider === 'openai') {
    return createOpenAI({ apiKey: key })(model);
  }
  // ollama — the only remaining provider with a defaults entry.
  const baseURL = `${(cred.ollamaBaseUrl ?? 'http://localhost:11434').trim().replace(/\/$/, '')}/v1`;
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

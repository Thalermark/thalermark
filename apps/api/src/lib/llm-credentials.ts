import { type LlmCredential, isCredentialUsable } from '@thalermark/ai';

// The open-core credential-resolution door (spikes/SAAS-AND-PRODUCTION.md §8.3,
// door #4). The AI routes ask "what LLM credential does this account run under?"
// per call; an injected resolver answers. Self-host answers with one global
// credential for every account (the LLM_* env); the managed platform answers
// per account (a tenant's own BYOK key, or a managed key). Sibling of the
// EntitlementProvider seam: entitlement decides "may this account use AI at
// all?" (plan), this decides "with which key?". A null answer means no usable
// credential → the route 503s, exactly as a missing global key did before.

export type LlmAccount = { accountId: string };

export interface LlmCredentialResolver {
  // The credential to run this account's AI calls under, or null when none is
  // available. Async so a per-account resolver can read (and decrypt) a stored
  // BYOK key from the DB; the community default resolves synchronously.
  resolve(account: LlmAccount): Promise<LlmCredential | null>;
}

// The LLM_* env block, matching the committed .env.example "LLM (Vercel AI SDK)"
// section. Structurally satisfied by process.env.
export type LlmEnvVars = {
  LLM_PROVIDER?: string;
  LLM_API_KEY?: string;
  LLM_MODEL_VISION?: string;
  LLM_MODEL_REASONING?: string;
  LLM_MODEL_FAST?: string;
  OLLAMA_BASE_URL?: string;
};

// Map the UPPER_SNAKE env block to the credential bundle packages/ai consumes.
export function credentialFromEnv(env: LlmEnvVars): LlmCredential {
  return {
    provider: env.LLM_PROVIDER,
    apiKey: env.LLM_API_KEY,
    modelVision: env.LLM_MODEL_VISION,
    modelReasoning: env.LLM_MODEL_REASONING,
    modelFast: env.LLM_MODEL_FAST,
    ollamaBaseUrl: env.OLLAMA_BASE_URL,
  };
}

// Community / self-host default: one global credential from the LLM_* env for
// every account. Returns null when the env has no usable provider (no key, or an
// unknown LLM_PROVIDER), so a no-key self-host 503s the AI routes exactly as it
// did when the extractor was built null at boot. The public composition root
// (server.ts) injects this; the commercial root swaps in a per-account resolver.
export function envLlmCredentials(env: LlmEnvVars): LlmCredentialResolver {
  const cred = credentialFromEnv(env);
  const value = isCredentialUsable(cred) ? cred : null;
  return { resolve: async () => value };
}

// The omitted default (no provider wired) — AI routes 503. Used when AppDeps
// carries no resolver (embedders, tests that don't exercise AI).
export const nullLlmCredentials: LlmCredentialResolver = {
  resolve: async () => null,
};

// Resolve the credential for an account, applying the omitted-resolver fallback.
// The AI routes call this and 503 on null. Centralises the `?? nullLlmCredentials`
// so every AI door treats a missing resolver identically.
export function resolveAccountCredential(
  deps: { llmCredentials?: LlmCredentialResolver },
  accountId: string,
): Promise<LlmCredential | null> {
  return (deps.llmCredentials ?? nullLlmCredentials).resolve({ accountId });
}

import type { LlmCredential } from '@thalermark/ai';

// The open-core credential-resolution door (spikes/SAAS-AND-PRODUCTION.md §8.3,
// door #4). The AI routes ask "what LLM credential does this account run under?"
// per call; an injected resolver answers. Self-host answers per account from a
// stored connection it owns (settingsLlmCredentials in lib/llm-connection.ts —
// the LLM_* env was removed); the managed platform answers per account (a
// tenant's own BYOK key, or a managed key). Sibling of the EntitlementProvider
// seam: entitlement decides "may this account use AI at all?" (plan), this
// decides "with which key?". A null answer means no usable credential → the
// route 503s, exactly as a missing key does.

export type LlmAccount = { accountId: string };

export interface LlmCredentialResolver {
  // The credential to run this account's AI calls under, or null when none is
  // available. Async so the resolver can read (and decrypt) the stored
  // connection from the DB.
  resolve(account: LlmAccount): Promise<LlmCredential | null>;
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

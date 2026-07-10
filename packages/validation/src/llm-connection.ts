import { z } from 'zod';

// Input for PUT /api/settings/ai — the AI connection the workspace owns
// (Settings → AI). accountId comes from the rls-context middleware; the client
// supplies the provider and its overrides.
//
// `provider` is validated as a non-empty string here and checked against the
// PRESETS registry in the route (unknown_provider → 400): the preset table lives
// in @thalermark/ai and validation must not depend on it.
//
// `apiKey` is deliberately tri-state, matching the store's ConnectionInput:
//   omitted   — keep the stored key (the UI shows a masked hint and only sends a
//               new value when the admin retypes one)
//   ""/null   — clear the key (e.g. switching to Ollama)
//   string    — a new key
// `structured` is NOT accepted: it is detected by the verify probe, never set by
// a user.
//
// baseUrl is only shape-checked here (a URL string). The SSRF guard —
// scheme + resolved-IP allow/deny — runs in the route via checkBaseUrl, because
// it depends on the operator's AI_ALLOW_PRIVATE_ENDPOINTS policy and on DNS.
export const llmConnectionUpsertSchema = z.object({
  provider: z.string().min(1).max(64),
  baseUrl: z.string().url().max(2048).nullish(),
  apiKey: z.string().max(1024).nullish(),
  modelVision: z.string().max(256).nullish(),
  modelReasoning: z.string().max(256).nullish(),
  modelFast: z.string().max(256).nullish(),
});

export type LlmConnectionUpsertInput = z.infer<typeof llmConnectionUpsertSchema>;

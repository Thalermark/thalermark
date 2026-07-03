import { describe, expect, it } from 'vitest';
import { type LlmCredential, isCredentialUsable, resolveModel } from './provider.js';

// isCredentialUsable is the vetting the credential resolver relies on: it must
// return true exactly when resolveModel would return a model, so a vetted
// credential never yields a null model at the call site.
describe('isCredentialUsable', () => {
  it('anthropic/openai need a non-blank key', () => {
    expect(isCredentialUsable({ provider: 'anthropic', apiKey: 'sk-x' })).toBe(true);
    expect(isCredentialUsable({ provider: 'openai', apiKey: 'sk-x' })).toBe(true);
    expect(isCredentialUsable({ provider: 'anthropic' })).toBe(false);
    expect(isCredentialUsable({ provider: 'anthropic', apiKey: '   ' })).toBe(false);
  });

  it('defaults to anthropic when provider is unset', () => {
    expect(isCredentialUsable({ apiKey: 'sk-x' })).toBe(true);
    expect(isCredentialUsable({})).toBe(false);
  });

  it('ollama needs no key', () => {
    expect(isCredentialUsable({ provider: 'ollama' })).toBe(true);
  });

  it('an unknown provider is never usable', () => {
    expect(isCredentialUsable({ provider: 'gemini', apiKey: 'x' })).toBe(false);
  });

  it('is case/whitespace-insensitive on the provider name', () => {
    expect(isCredentialUsable({ provider: '  Anthropic ', apiKey: 'sk-x' })).toBe(true);
  });
});

describe('resolveModel', () => {
  const each = (cred: LlmCredential) =>
    (['vision', 'reasoning', 'fast'] as const).map((r) => resolveModel(cred, r));

  it('returns a model for every role when the credential is usable', () => {
    for (const m of each({ provider: 'anthropic', apiKey: 'sk-x' })) expect(m).not.toBeNull();
    for (const m of each({ provider: 'openai', apiKey: 'sk-x' })) expect(m).not.toBeNull();
    for (const m of each({ provider: 'ollama' })) expect(m).not.toBeNull();
  });

  it('returns null for every role when the credential is not usable', () => {
    for (const m of each({ provider: 'anthropic' })) expect(m).toBeNull();
    for (const m of each({ provider: 'gemini', apiKey: 'x' })) expect(m).toBeNull();
    for (const m of each({})) expect(m).toBeNull();
  });
});

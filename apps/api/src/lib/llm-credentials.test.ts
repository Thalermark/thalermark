import { describe, expect, it } from 'vitest';
import {
  credentialFromEnv,
  envLlmCredentials,
  nullLlmCredentials,
  resolveAccountCredential,
} from './llm-credentials.js';

const account = { accountId: '00000000-0000-0000-0000-000000000000' };

describe('credentialFromEnv', () => {
  it('maps the LLM_* env block to the camelCase credential bundle', () => {
    expect(
      credentialFromEnv({
        LLM_PROVIDER: 'openai',
        LLM_API_KEY: 'sk-x',
        LLM_MODEL_VISION: 'gpt-4o',
        LLM_MODEL_REASONING: 'o1',
        LLM_MODEL_FAST: 'gpt-4o-mini',
        OLLAMA_BASE_URL: 'http://ollama:11434',
      }),
    ).toEqual({
      provider: 'openai',
      apiKey: 'sk-x',
      modelVision: 'gpt-4o',
      modelReasoning: 'o1',
      modelFast: 'gpt-4o-mini',
      baseUrl: 'http://ollama:11434',
    });
  });
});

describe('envLlmCredentials', () => {
  it('returns the global credential for every account when a key is configured', async () => {
    const resolver = envLlmCredentials({ LLM_PROVIDER: 'anthropic', LLM_API_KEY: 'sk-x' });
    expect(await resolver.resolve(account)).toEqual({
      provider: 'anthropic',
      apiKey: 'sk-x',
      modelVision: undefined,
      modelReasoning: undefined,
      modelFast: undefined,
      baseUrl: undefined,
    });
    // Same answer for any account — this is the one-global-key self-host model.
    expect(await resolver.resolve({ accountId: 'other' })).not.toBeNull();
  });

  it('resolves null when no provider is usable (no key → AI routes 503)', async () => {
    expect(await envLlmCredentials({ LLM_PROVIDER: 'anthropic' }).resolve(account)).toBeNull();
    expect(await envLlmCredentials({}).resolve(account)).toBeNull();
    expect(
      await envLlmCredentials({ LLM_PROVIDER: 'gemini', LLM_API_KEY: 'x' }).resolve(account),
    ).toBeNull();
  });

  it('resolves a credential for ollama with no key', async () => {
    expect(await envLlmCredentials({ LLM_PROVIDER: 'ollama' }).resolve(account)).not.toBeNull();
  });
});

describe('nullLlmCredentials', () => {
  it('always resolves null', async () => {
    expect(await nullLlmCredentials.resolve(account)).toBeNull();
  });
});

describe('resolveAccountCredential', () => {
  it('uses the injected resolver when present', async () => {
    const deps = { llmCredentials: envLlmCredentials({ LLM_API_KEY: 'sk-x' }) };
    expect(await resolveAccountCredential(deps, account.accountId)).not.toBeNull();
  });

  it('falls back to null (no AI) when no resolver is wired', async () => {
    expect(await resolveAccountCredential({}, account.accountId)).toBeNull();
  });
});

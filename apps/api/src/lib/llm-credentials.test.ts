import { describe, expect, it } from 'vitest';
import {
  type LlmCredentialResolver,
  nullLlmCredentials,
  resolveAccountCredential,
} from './llm-credentials.js';

const account = { accountId: '00000000-0000-0000-0000-000000000000' };

describe('nullLlmCredentials', () => {
  it('always resolves null', async () => {
    expect(await nullLlmCredentials.resolve(account)).toBeNull();
  });
});

describe('resolveAccountCredential', () => {
  it('uses the injected resolver when present', async () => {
    const resolver: LlmCredentialResolver = {
      resolve: async () => ({ provider: 'anthropic', apiKey: 'sk-x' }),
    };
    expect(await resolveAccountCredential({ llmCredentials: resolver }, account.accountId)).toEqual(
      {
        provider: 'anthropic',
        apiKey: 'sk-x',
      },
    );
  });

  it('passes the account id through to the resolver', async () => {
    const seen: string[] = [];
    const resolver: LlmCredentialResolver = {
      resolve: async ({ accountId }) => {
        seen.push(accountId);
        return null;
      },
    };
    await resolveAccountCredential({ llmCredentials: resolver }, 'abc');
    expect(seen).toEqual(['abc']);
  });

  it('falls back to null (no AI) when no resolver is wired', async () => {
    expect(await resolveAccountCredential({}, account.accountId)).toBeNull();
  });
});

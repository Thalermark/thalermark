import type { LlmCredential } from '@thalermark/ai';
import { describe, expect, it } from 'vitest';
import { deriveConnectionKey, encryptSecret } from './crypto.js';
import {
  type ConnectionRow,
  type LlmConnectionReader,
  rowToCredential,
  settingsLlmCredentials,
} from './llm-connection.js';

const key = deriveConnectionKey('a-genuinely-random-better-auth-secret');
const account = { accountId: '00000000-0000-0000-0000-000000000000' };
const HEALTHY = new Date('2026-07-10T00:00:00Z');

const row = (over: Partial<ConnectionRow> = {}): ConnectionRow => ({
  id: '11111111-1111-1111-1111-111111111111',
  accountId: account.accountId,
  provider: 'anthropic',
  baseUrl: null,
  apiKeyCiphertext: encryptSecret('sk-ant-x', key),
  modelVision: null,
  modelReasoning: null,
  modelFast: null,
  structured: null,
  lastOkAt: HEALTHY,
  lastErrorAt: null,
  lastError: null,
  updatedBy: '22222222-2222-2222-2222-222222222222',
  createdAt: HEALTHY,
  updatedAt: HEALTHY,
  ...over,
});

describe('rowToCredential — the health gate', () => {
  it('resolves a healthy row', () => {
    expect(rowToCredential(row(), key)).toEqual({ provider: 'anthropic', apiKey: 'sk-ant-x' });
  });

  // A broken save must never take AI live.
  it('refuses a row that has never succeeded', () => {
    expect(rowToCredential(row({ lastOkAt: null }), key)).toBeNull();
  });

  // Sticky: once it has worked, it owns the account. A recent failure does not
  // demote it, and above all does not fall back to some other key.
  it('still resolves a row that has succeeded before but failed recently', () => {
    const credential = rowToCredential(
      row({ lastErrorAt: new Date(), lastError: 'invalid x-api-key' }),
      key,
    );
    expect(credential).toMatchObject({ provider: 'anthropic' });
  });

  it('fails closed when the ciphertext will not open (rotated auth secret)', () => {
    expect(rowToCredential(row(), deriveConnectionKey('a-different-secret'))).toBeNull();
    expect(rowToCredential(row({ apiKeyCiphertext: 'v1:garbage' }), key)).toBeNull();
  });

  it('resolves a keyless provider (ollama needs none)', () => {
    const credential = rowToCredential(
      row({ provider: 'ollama', apiKeyCiphertext: null, baseUrl: 'http://ollama:11434' }),
      key,
    );
    expect(credential).toEqual({ provider: 'ollama', baseUrl: 'http://ollama:11434' });
  });
});

// NULL means "use the preset's value". LlmCredential expresses that by omitting
// the key — an explicit `undefined` would still shadow the preset in a spread.
describe('rowToCredential — null means "trust the preset"', () => {
  it('omits unset columns rather than setting them undefined', () => {
    const credential = rowToCredential(row(), key) as LlmCredential;
    for (const field of ['baseUrl', 'modelVision', 'modelReasoning', 'modelFast', 'structured']) {
      expect(Object.hasOwn(credential, field)).toBe(false);
    }
  });

  it('carries structured:false through, which is not the same as absent', () => {
    const credential = rowToCredential(row({ structured: false }), key) as LlmCredential;
    expect(Object.hasOwn(credential, 'structured')).toBe(true);
    expect(credential.structured).toBe(false);
  });

  it('maps every override column onto the credential', () => {
    const credential = rowToCredential(
      row({
        provider: 'custom',
        baseUrl: 'https://api.x.ai/v1',
        modelVision: 'v',
        modelReasoning: 'r',
        modelFast: 'f',
        structured: true,
      }),
      key,
    );
    expect(credential).toEqual({
      provider: 'custom',
      apiKey: 'sk-ant-x',
      baseUrl: 'https://api.x.ai/v1',
      modelVision: 'v',
      modelReasoning: 'r',
      modelFast: 'f',
      structured: true,
    });
  });
});

describe('settingsLlmCredentials', () => {
  const readerOf = (credential: LlmCredential | null): LlmConnectionReader => ({
    getUsable: async () => credential,
  });

  it('is one lookup — whatever the reader says, with no fallback', async () => {
    const credential: LlmCredential = { provider: 'ollama' };
    expect(await settingsLlmCredentials(readerOf(credential)).resolve(account)).toBe(credential);
  });

  // The whole point of deleting the env: there is nothing left to fall back to.
  it('resolves null when the account has no usable connection', async () => {
    expect(await settingsLlmCredentials(readerOf(null)).resolve(account)).toBeNull();
  });

  it('passes the account id straight through', async () => {
    const seen: string[] = [];
    const reader: LlmConnectionReader = {
      getUsable: async (accountId) => {
        seen.push(accountId);
        return null;
      },
    };
    await settingsLlmCredentials(reader).resolve({ accountId: 'abc' });
    expect(seen).toEqual(['abc']);
  });
});

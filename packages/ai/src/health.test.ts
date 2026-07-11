import { APICallError, LoadAPIKeyError } from 'ai';
import { describe, expect, it } from 'vitest';
import { describeLlmError, isConnectionHealthError } from './health.js';

// Minimal APICallError builder — only the fields the classifier reads.
function apiError(opts: {
  statusCode?: number;
  isRetryable: boolean;
  message?: string;
}): APICallError {
  return new APICallError({
    message: opts.message ?? 'boom',
    url: 'https://api.example.com/v1/chat/completions',
    requestBodyValues: {},
    statusCode: opts.statusCode,
    isRetryable: opts.isRetryable,
  });
}

describe('isConnectionHealthError', () => {
  it('records a permanent auth failure (bad/revoked key)', () => {
    expect(isConnectionHealthError(apiError({ statusCode: 401, isRetryable: false }))).toBe(true);
    expect(isConnectionHealthError(apiError({ statusCode: 403, isRetryable: false }))).toBe(true);
  });

  it('records a permanent config failure (bad model / request)', () => {
    for (const statusCode of [400, 404, 422]) {
      expect(isConnectionHealthError(apiError({ statusCode, isRetryable: false }))).toBe(true);
    }
  });

  it('records a missing/unloadable key', () => {
    expect(isConnectionHealthError(new LoadAPIKeyError({ message: 'no key' }))).toBe(true);
  });

  // The whole point: a blip must not redden the chip on a working connection.
  it('ignores a transient failure (the SDK marks it retryable)', () => {
    expect(isConnectionHealthError(apiError({ statusCode: 429, isRetryable: true }))).toBe(false);
    expect(isConnectionHealthError(apiError({ statusCode: 500, isRetryable: true }))).toBe(false);
    expect(isConnectionHealthError(apiError({ statusCode: 503, isRetryable: true }))).toBe(false);
  });

  it('ignores a non-retryable error with an unclassified status (fail safe)', () => {
    expect(isConnectionHealthError(apiError({ statusCode: 418, isRetryable: false }))).toBe(false);
    expect(isConnectionHealthError(apiError({ isRetryable: false }))).toBe(false);
  });

  it('ignores an unrecognized throw (timeout / network / generic)', () => {
    expect(isConnectionHealthError(new Error('aborted'))).toBe(false);
    expect(isConnectionHealthError('nope')).toBe(false);
    expect(isConnectionHealthError(undefined)).toBe(false);
  });
});

describe('describeLlmError', () => {
  it('redacts the api key from the message', () => {
    const msg = describeLlmError(new Error('401 for key sk-ant-secret-123'), 'sk-ant-secret-123');
    expect(msg).not.toContain('sk-ant-secret-123');
    expect(msg).toContain('••••');
  });

  it('truncates a runaway body', () => {
    expect(describeLlmError(new Error('x'.repeat(5000))).length).toBeLessThanOrEqual(300);
  });

  it('handles a non-Error throw', () => {
    expect(describeLlmError('plain string')).toBe('plain string');
  });
});

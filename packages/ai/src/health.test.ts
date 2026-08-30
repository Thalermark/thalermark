import { APICallError, LoadAPIKeyError, RetryError } from 'ai';
import { describe, expect, it } from 'vitest';
import { describeLlmError, isConnectionHealthError } from './health.js';

// Minimal APICallError builder — only the fields the classifier reads.
function apiError(opts: {
  statusCode?: number;
  isRetryable: boolean;
  message?: string;
  responseBody?: string;
}): APICallError {
  return new APICallError({
    message: opts.message ?? 'boom',
    url: 'https://api.example.com/v1/chat/completions',
    requestBodyValues: {},
    statusCode: opts.statusCode,
    isRetryable: opts.isRetryable,
    responseBody: opts.responseBody,
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

  // TMC-296: a 5xx whose body says the MODEL failed to load fails identically
  // forever. Ollama serves it as a retryable 500, which is how a dead vision
  // model stayed green while every extraction failed.
  it('records a model-load failure even though the provider marked it retryable', () => {
    const bodies = [
      "llama-server process has terminated: exit status 1: error loading model: unknown model architecture: 'mllama'",
      'unable to load model /models/foo.gguf',
    ];
    for (const responseBody of bodies) {
      expect(
        isConnectionHealthError(apiError({ statusCode: 500, isRetryable: true, responseBody })),
      ).toBe(true);
    }
    // Falls back to the message when no body was captured.
    expect(
      isConnectionHealthError(
        apiError({ statusCode: 500, isRetryable: true, message: 'error loading model' }),
      ),
    ).toBe(true);
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

  // Live routes call with retries, so their failures arrive WRAPPED in a
  // RetryError — the classifier must see through it to the last attempt, or
  // the live path never records anything the probe path would (TMC-296).
  it('classifies through a RetryError to the last underlying attempt', () => {
    const wrap = (last: unknown) =>
      new RetryError({
        message: 'Failed after 2 attempts.',
        reason: 'maxRetriesExceeded',
        errors: [last],
      });
    expect(
      isConnectionHealthError(
        wrap(
          apiError({ statusCode: 500, isRetryable: true, responseBody: 'error loading model x' }),
        ),
      ),
    ).toBe(true);
    expect(isConnectionHealthError(wrap(apiError({ statusCode: 401, isRetryable: false })))).toBe(
      true,
    );
    // A wrapped transient stays transient.
    expect(isConnectionHealthError(wrap(apiError({ statusCode: 503, isRetryable: true })))).toBe(
      false,
    );
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

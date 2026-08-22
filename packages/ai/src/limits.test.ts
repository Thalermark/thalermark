import { beforeEach, describe, expect, it, vi } from 'vitest';

// Capture what the SDK was actually asked for. These three calls used to pass
// neither a signal nor a retry cap, which let one hung provider hold a request
// (and a pool connection) for roughly fifteen minutes.
const generateObject = vi.fn();
vi.mock('ai', () => ({
  generateObject: (...args: unknown[]) => generateObject(...args),
  APICallError: class extends Error {},
}));

const { createCashFlowAdvisor } = await import('./advisor.js');
const { createExpenseCategorizer } = await import('./categorizer.js');
const { createReceiptExtractor } = await import('./extractor.js');
const { ADVISE_TIMEOUT_MS, AI_MAX_RETRIES, CATEGORIZE_TIMEOUT_MS, EXTRACT_TIMEOUT_MS } =
  await import('./limits.js');

import type { LlmCredential } from './provider.js';

const cred: LlmCredential = { provider: 'anthropic', apiKey: 'sk-ant-test-key' };

const signals = {
  asOf: '2026-08-14',
  cashOnHand: '100.00',
  monthToDate: { moneyIn: '10.00', moneyOut: '5.00' },
  trailingMonths: [],
  owed: '0.00',
  overdueCount: 0,
  businessType: 'sole_prop',
  latePayers: [],
  categoryMovers: [],
  merchantMovers: [],
};

describe('every production model call is bounded', () => {
  beforeEach(() => generateObject.mockReset());

  it('advise passes a retry cap and a deadline', async () => {
    generateObject.mockResolvedValue({ object: { nudges: [] } });
    // biome-ignore lint/suspicious/noExplicitAny: the signals shape is exercised elsewhere
    await createCashFlowAdvisor().advise(signals as any, cred);

    const opts = generateObject.mock.calls[0]?.[0];
    expect(opts.maxRetries).toBe(AI_MAX_RETRIES);
    expect(opts.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('categorize passes a retry cap and a deadline', async () => {
    generateObject.mockResolvedValue({ object: { suggestedCategoryCode: '6000' } });
    await createExpenseCategorizer().categorize(
      {
        merchant: 'Acme',
        allowedCategories: [{ code: '6000', name: 'Advertising' }],
        businessType: null,
      },
      cred,
    );

    const opts = generateObject.mock.calls[0]?.[0];
    expect(opts.maxRetries).toBe(AI_MAX_RETRIES);
    expect(opts.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('extract passes a retry cap and a deadline', async () => {
    generateObject.mockResolvedValue({
      object: { merchant: null, total: null, expenseDate: null, taxAmount: null },
    });
    await createReceiptExtractor().extractReceipt(
      {
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: 'image/png',
        allowedCategories: [{ code: '6000', name: 'Advertising' }],
        businessType: null,
      },
      cred,
    );

    const opts = generateObject.mock.calls[0]?.[0];
    expect(opts.maxRetries).toBe(AI_MAX_RETRIES);
    expect(opts.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('caps retries below the SDK default of two', () => {
    // The default means three attempts, and each one gets the full undici
    // timeout. The cap is the difference between a bounded failure and a
    // fifteen-minute one.
    expect(AI_MAX_RETRIES).toBeLessThan(2);
  });

  it('budgets enough for a cold local model, and orders them by weight', () => {
    // probe.ts measured a 14B on CPU taking ~37s to become ready. Anything
    // under that fails the self-hoster the BYOK path exists for.
    for (const ms of [CATEGORIZE_TIMEOUT_MS, ADVISE_TIMEOUT_MS, EXTRACT_TIMEOUT_MS]) {
      expect(ms).toBeGreaterThan(37_000);
    }
    // Vision with an image attached is the slowest; a short categorize is the
    // quickest. If these ever inverted, someone mis-tuned a number.
    expect(CATEGORIZE_TIMEOUT_MS).toBeLessThanOrEqual(ADVISE_TIMEOUT_MS);
    expect(ADVISE_TIMEOUT_MS).toBeLessThanOrEqual(EXTRACT_TIMEOUT_MS);
  });
});

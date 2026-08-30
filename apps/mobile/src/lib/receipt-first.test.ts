import { describe, expect, it } from 'vitest';
import { extractionPrefill, hasPrefill, readFailureNotice } from './receipt-first';

const CAT = '01890000-0000-7000-8000-000000000001';
const KNOWN = new Set([CAT]);

describe('extractionPrefill', () => {
  it('prefills every field the model read', () => {
    const prefill = extractionPrefill(
      {
        extraction: { merchant: 'Acme Tools', total: '19.99', expenseDate: '2026-05-02' },
        suggestedCategoryAccountId: CAT,
      },
      KNOWN,
    );
    expect(prefill).toEqual({
      merchant: 'Acme Tools',
      amount: '19.99',
      expenseDate: '2026-05-02',
      categoryAccountId: CAT,
    });
  });

  it('keeps a partial read and leaves the unread fields alone', () => {
    const prefill = extractionPrefill(
      {
        extraction: { merchant: 'Acme Tools', total: null, expenseDate: null },
        suggestedCategoryAccountId: null,
      },
      KNOWN,
    );
    expect(prefill).toEqual({ merchant: 'Acme Tools' });
    expect(hasPrefill(prefill)).toBe(true);
  });

  it('drops a suggested category that is not in the loaded chart', () => {
    const prefill = extractionPrefill(
      {
        extraction: { merchant: null, total: null, expenseDate: null },
        suggestedCategoryAccountId: '01890000-0000-7000-8000-00000000dead',
      },
      KNOWN,
    );
    expect(prefill).toEqual({});
    expect(hasPrefill(prefill)).toBe(false);
  });
});

describe('readFailureNotice', () => {
  it('points an unconfigured server at Settings → AI', () => {
    expect(readFailureNotice('ai_not_configured')).toContain('Settings → AI');
  });

  it('is silent about blame for every other failure', () => {
    for (const code of ['extraction_failed', 'network', 'unknown', 'rate_limited']) {
      const text = readFailureNotice(code);
      expect(text).toContain('photo will still be saved');
      expect(text.toLowerCase()).not.toContain('clearer');
    }
  });
});

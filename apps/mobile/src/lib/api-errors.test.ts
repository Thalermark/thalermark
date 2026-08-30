import { describe, expect, it } from 'vitest';
import { apiErrorMessage } from './api-errors';

// The rules about which error means what. The regression this guards is
// specific: a code used to come back out of here so a screen's own switch could
// match on it, and screens rendered the result directly, which is how someone
// who lost signal mid-save was shown the word `create_failed`.

describe('apiErrorMessage', () => {
  it('NEVER returns a bare code', () => {
    const out = apiErrorMessage('create_failed', 'fallback');
    expect(out).not.toBe('create_failed');
    expect(out).toMatch(/[a-z] [a-z]/i);
  });

  it('falls back for a code it does not know, rather than printing it', () => {
    expect(apiErrorMessage('some_unmapped_code', 'Something went wrong.')).toBe(
      'Something went wrong.',
    );
  });

  it('passes through a value that is already a sentence', () => {
    // A caller translated it before handing it on.
    const sentence = 'Your card was declined by the bank.';
    expect(apiErrorMessage(sentence, 'fallback')).toBe(sentence);
  });

  it('falls back when there is no code at all', () => {
    expect(apiErrorMessage(undefined, 'Something went wrong.')).toBe('Something went wrong.');
  });

  describe('period_closed', () => {
    it('names the year the user cares about, not the exclusive bound', () => {
      // closed_through is 1 Jan of the FOLLOWING year, so 2026-01-01 means 2025
      // is the closed year.
      const out = apiErrorMessage('period_closed', 'fallback', { closedThrough: '2026-01-01' });
      expect(out).toContain('2025');
      expect(out).not.toContain('2026');
    });

    it('covers recording as well as changing', () => {
      // "changed" alone undersold it: a closed year also refuses anything NEWLY
      // dated inside it, which is how sending an invoice dated last December can
      // fail in March.
      const out = apiErrorMessage('period_closed', 'fallback', { closedThrough: '2026-01-01' });
      expect(out).toMatch(/record/i);
    });

    it('degrades to a year-less sentence when the body carries no date', () => {
      const out = apiErrorMessage('period_closed', 'fallback', {});
      expect(out).toMatch(/closed/i);
      expect(out).not.toMatch(/\d{4}/);
    });

    it('ignores a closedThrough that is not a string', () => {
      const out = apiErrorMessage('period_closed', 'fallback', { closedThrough: 2026 });
      expect(out).not.toMatch(/\d{4}/);
    });
  });

  describe('company_retired', () => {
    it('does not name a date, because the date is not the problem', () => {
      const out = apiErrorMessage('company_retired', 'fallback', { retiredAt: '2026-03-03' });
      expect(out).not.toMatch(/\d{4}/);
      expect(out).toMatch(/closed/i);
    });
  });

  describe('invalid_body', () => {
    it('prefers a field-level message, which is written for the person', () => {
      const out = apiErrorMessage('invalid_body', 'fallback', {
        issues: [{ message: 'Enter how many visits you did' }],
      });
      expect(out).toBe('Enter how many visits you did');
    });

    it('skips zod internal-sounding defaults and falls through', () => {
      const out = apiErrorMessage('invalid_body', 'fallback', {
        issues: [{ message: 'invalid_type' }],
      });
      expect(out).not.toBe('invalid_type');
    });

    it('falls through when the body carries no issues', () => {
      expect(typeof apiErrorMessage('invalid_body', 'fallback', {})).toBe('string');
    });
  });
});

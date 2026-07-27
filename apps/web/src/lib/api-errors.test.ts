import { describe, expect, it } from 'vitest';
import { apiErrorMessage } from './api-errors';

// The shared translation for cross-cutting API error codes. The behaviour that
// matters is the pass-through: several routes feed this into their own
// `formErrorFor` switch, so an unrecognised code has to come back UNCHANGED or
// every route-specific message silently regresses to a generic one.

describe('apiErrorMessage', () => {
  // Asserting on the properties rather than the exact sentence: pinning the
  // string verbatim just restates the implementation and turns every copy edit
  // into a failing test. What has to hold is the year arithmetic and the way out.
  it('names the closed year from closedThrough', () => {
    // closed_through is the exclusive upper bound — 1 Jan of the following year —
    // so the year the user cares about is the one before it.
    const msg = apiErrorMessage('period_closed', 'x', {
      closedThrough: '2026-01-01T00:00:00.000Z',
    });
    expect(msg).toContain('2025');
    expect(msg).not.toContain('2026');
    expect(msg).toContain('Ledger');
  });

  it('falls back to a year-less sentence when closedThrough is missing or odd', () => {
    for (const body of [undefined, null, { closedThrough: 12345 }, 'not an object']) {
      const msg = apiErrorMessage('period_closed', 'x', body);
      expect(msg).not.toMatch(/\d{4}/);
      expect(msg).toContain('Ledger');
    }
  });

  it('names a closed business without naming a date', () => {
    // Same structural cause as period_closed — raised in the posting funnel, so
    // it can surface from any route that writes money. It shipped as a raw code
    // for one release because the code was added without a message.
    const msg = apiErrorMessage('company_retired', 'x');
    expect(msg).toContain('closed');
    expect(msg).toContain('Business settings');
    // No date: the date isn't the problem, the business being finished is.
    expect(msg).not.toMatch(/\d{4}/);
  });

  it('passes an unrecognised code through untouched', () => {
    // This is what keeps `formErrorFor(apiErrorMessage(...))` working: the inner
    // call must not swallow the code the outer switch is about to match on.
    expect(apiErrorMessage('invalid_category_account', 'create_failed')).toBe(
      'invalid_category_account',
    );
    expect(apiErrorMessage('bill_not_editable', 'update_failed')).toBe('bill_not_editable');
  });

  it('uses the fallback only when there is no code at all', () => {
    expect(apiErrorMessage(undefined, 'create_failed')).toBe('create_failed');
  });
});

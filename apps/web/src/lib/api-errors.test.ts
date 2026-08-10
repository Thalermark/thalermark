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

  it('translates a code from the shared catalogue', () => {
    expect(apiErrorMessage('invalid_recipient', 'Could not send.')).toMatch(/email address/i);
    expect(apiErrorMessage('has_payments', 'Could not void.')).toMatch(/payments/i);
  });

  // The behaviour this file used to assert the opposite of. Returning the code
  // was deliberate — it let a route's own switch match on it — and it is how
  // `invalid_recipient` reached a user's screen, because every switch ended in
  // `default: return code` (TMC-219).
  it('never returns a code, however unrecognised', () => {
    const msg = apiErrorMessage('some_future_code_nobody_mapped', 'That did not work. Try again.');
    expect(msg).toBe('That did not work. Try again.');
  });

  // Route-specific copy still wins: the switch runs first and this only sees
  // what it did not handle. A value that is already a sentence has to survive.
  it('passes an already-translated sentence through untouched', () => {
    const sentence = 'That category is no longer a valid expense account. Pick another.';
    expect(apiErrorMessage(sentence, 'unused fallback')).toBe(sentence);
  });

  it('uses the fallback when there is no code at all', () => {
    expect(apiErrorMessage(undefined, 'That could not be saved.')).toBe('That could not be saved.');
  });
});

import { describe, expect, it } from 'vitest';
import { apiErrorMessage } from './api-errors';

// The shared translation for cross-cutting API error codes. The behaviour that
// matters is the pass-through: several routes feed this into their own
// `formErrorFor` switch, so an unrecognised code has to come back UNCHANGED or
// every route-specific message silently regresses to a generic one.

describe('apiErrorMessage', () => {
  it('names the closed year from closedThrough', () => {
    // closed_through is the exclusive upper bound — 1 Jan of the following year —
    // so the year the user cares about is the one before it.
    expect(
      apiErrorMessage('period_closed', 'x', { closedThrough: '2026-01-01T00:00:00.000Z' }),
    ).toBe("2025 is closed, so it can't be changed. Re-open it in the Ledger first.");
  });

  it('falls back to a year-less sentence when closedThrough is missing or odd', () => {
    const generic = "That year is closed, so it can't be changed. Re-open it in the Ledger first.";
    expect(apiErrorMessage('period_closed', 'x')).toBe(generic);
    expect(apiErrorMessage('period_closed', 'x', null)).toBe(generic);
    expect(apiErrorMessage('period_closed', 'x', { closedThrough: 12345 })).toBe(generic);
    expect(apiErrorMessage('period_closed', 'x', 'not an object')).toBe(generic);
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

import { describe, expect, it } from 'vitest';
import { defaultPolicyId, lineTax, policyRate, resolvePolicyId } from './line-tax';

// Money, computed client-side because mobile is a direct API client with no
// server action. It sends the per-line taxRatePct and taxAmount it works out
// here, so a mistake in this file posts wrong numbers to the ledger.

const policies = [
  { id: 'std', name: 'Standard', ratePct: '8.25', isDefault: true },
  { id: 'zero', name: 'Exempt', ratePct: '0', isDefault: false },
];

describe('defaultPolicyId', () => {
  it('finds the company default', () => {
    expect(defaultPolicyId(policies)).toBe('std');
  });

  it('is empty when no default is set, rather than picking one', () => {
    expect(defaultPolicyId([{ id: 'a', isDefault: false }])).toBe('');
    expect(defaultPolicyId([])).toBe('');
  });
});

describe('policyRate', () => {
  it('reads the rate for a known policy', () => {
    expect(policyRate(policies, 'std')).toBe('8.25');
  });

  it('falls back to zero for a stale or removed reference, not to the default', () => {
    // Silently charging the default rate against an id that no longer exists
    // would invent tax the user never chose.
    expect(policyRate(policies, 'deleted')).toBe('0');
    expect(policyRate(policies, '')).toBe('0');
  });
});

describe('lineTax', () => {
  it('is zero when the line is not taxable, whatever the rate says', () => {
    expect(lineTax(false, '8.25', '100.00')).toBe('0');
  });

  it('rounds the same way the server does', () => {
    // taxOfAmount is bigint half-away-from-zero, matching the api.
    expect(lineTax(true, '8.25', '100.00')).toBe('8.25');
    expect(lineTax(true, '10', '0.05')).toBe('0.01');
  });

  it('is zero on a zero-rate policy', () => {
    expect(lineTax(true, '0', '100.00')).toBe('0.00');
  });
});

describe('resolvePolicyId', () => {
  it('keeps a preference that still exists', () => {
    expect(resolvePolicyId(policies, 'zero')).toBe('zero');
  });

  it('falls back to the default when the preference is archived or empty', () => {
    expect(resolvePolicyId(policies, 'deleted')).toBe('std');
    expect(resolvePolicyId(policies, '')).toBe('std');
  });

  it('falls back to the first policy when there is no default at all', () => {
    const noDefault = [{ id: 'only', name: 'Only', ratePct: '5', isDefault: false }];
    expect(resolvePolicyId(noDefault, '')).toBe('only');
  });

  it('is empty when there are no policies', () => {
    expect(resolvePolicyId([], 'anything')).toBe('');
  });
});

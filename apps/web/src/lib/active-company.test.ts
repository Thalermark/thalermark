import type { Cookies } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import { ACTIVE_COMPANY_COOKIE, pickActiveCompany } from './active-company';

// Minimal Cookies stub — pickActiveCompany only reads the one cookie.
function cookiesWith(value: string | undefined): Cookies {
  return { get: (name: string) => (name === ACTIVE_COMPANY_COOKIE ? value : undefined) } as Cookies;
}

const companies = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

describe('pickActiveCompany', () => {
  it('returns the first company when no cookie is set', () => {
    expect(pickActiveCompany(cookiesWith(undefined), companies)?.id).toBe('a');
  });

  it('returns the cookie-named company when it is in the list', () => {
    expect(pickActiveCompany(cookiesWith('b'), companies)?.id).toBe('b');
  });

  it('falls back to the first company when the cookie is stale (not in the list)', () => {
    // e.g. a company id left over from another workspace, or a deleted company.
    expect(pickActiveCompany(cookiesWith('zzz'), companies)?.id).toBe('a');
  });

  it('returns undefined for an empty list', () => {
    expect(pickActiveCompany(cookiesWith('a'), [])).toBeUndefined();
  });
});

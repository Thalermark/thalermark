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

  // Retirement — a business that has stopped trading. Its books stay readable
  // for years, so it stays selectable; only the FALLBACK avoids it.
  describe('with retired companies', () => {
    const mixed = [
      { id: 'old', retiredAt: '2026-01-01T00:00:00.000Z' },
      { id: 'new', retiredAt: null },
    ];

    it('honors an explicit pick of a retired company', () => {
      // THE one that matters. If this fell through to the active company, every
      // report page would render the NEW company's figures while the switcher
      // still showed the old company's name — silent wrong financials.
      expect(pickActiveCompany(cookiesWith('old'), mixed)?.id).toBe('old');
    });

    it('skips retired companies when falling back', () => {
      expect(pickActiveCompany(cookiesWith(undefined), mixed)?.id).toBe('new');
      // A stale cookie is a fallback too — it must not land on dead books.
      expect(pickActiveCompany(cookiesWith('gone'), mixed)?.id).toBe('new');
    });

    it('still returns something when every company is retired', () => {
      // Retiring the last active company is refused by the API, but a workspace
      // could still reach this state; returning undefined would strand the user.
      const allRetired = [{ id: 'x', retiredAt: '2026-01-01T00:00:00.000Z' }];
      expect(pickActiveCompany(cookiesWith(undefined), allRetired)?.id).toBe('x');
    });
  });
});

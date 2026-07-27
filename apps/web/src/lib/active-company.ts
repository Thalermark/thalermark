import type { Cookies } from '@sveltejs/kit';

// Which company within the active workspace the user is currently working in.
// The account is the tenant (active_account_id cookie + x-account-id); a
// workspace can hold several companies, and this cookie picks the active one.
// It's a plain web-side concern: the API takes companyId per request and
// validates it belongs to the account, so "active company" is just which id the
// web sends — no header or RLS change needed.
export const ACTIVE_COMPANY_COOKIE = 'active_company_id';

const COOKIE_OPTS = {
  path: '/',
  httpOnly: true,
  sameSite: 'lax',
  maxAge: 60 * 60 * 24 * 365,
} as const;

export function setActiveCompany(cookies: Cookies, companyId: string): void {
  cookies.set(ACTIVE_COMPANY_COOKIE, companyId, COOKIE_OPTS);
}

// The raw cookie value, for the `+server.ts` load-more / search proxies that
// can't `await parent()` to read the validated active company. The (app) layout
// keeps this cookie healed to the resolved active company, so it's trustworthy
// by the time these run (they only fire after a list page has rendered). The
// API ANDs accountId on every filter, so even a stale value can't leak another
// account's rows — it would just return an empty page.
export function cookieCompanyId(cookies: Cookies): string | undefined {
  return cookies.get(ACTIVE_COMPANY_COOKIE);
}

// Resolve the active company from the workspace's company list. Honors the
// cookie only when it points at a company the account actually has — so a stale
// id (left over from another workspace, or a deleted company) self-heals rather
// than 404-ing the whole app. Returns undefined only for an empty list.
//
// Retired companies (a business that has stopped trading) are still SELECTABLE,
// deliberately: their books have to stay readable and reportable for years, so a
// user who explicitly switches to one must land on it. What retirement changes is
// only the FALLBACK — an unset or stale cookie resolves to the first company
// still trading, so nobody is dropped onto dead books by accident.
//
// The ordering here is load-bearing. Honoring the cookie BEFORE preferring an
// active company is what stops a retired-but-selected company being silently
// swapped for a different one — which would render another company's figures
// under the name the user still sees in the switcher.
export function pickActiveCompany<T extends { id: string; retiredAt?: string | null }>(
  cookies: Cookies,
  companies: T[],
): T | undefined {
  const wanted = cookies.get(ACTIVE_COMPANY_COOKIE);
  if (wanted) {
    const match = companies.find((c) => c.id === wanted);
    if (match) return match;
  }
  return companies.find((c) => !c.retiredAt) ?? companies[0];
}

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
// id (left over from another workspace, or a deleted company) self-heals to the
// first company rather than 404-ing the whole app. Falls back to the first
// company, matching the pre-switcher `companies[0]` behavior for single-company
// accounts. Returns undefined only for an empty list.
export function pickActiveCompany<T extends { id: string }>(
  cookies: Cookies,
  companies: T[],
): T | undefined {
  const wanted = cookies.get(ACTIVE_COMPANY_COOKIE);
  if (wanted) {
    const match = companies.find((c) => c.id === wanted);
    if (match) return match;
  }
  return companies[0];
}

import { getActiveCompanyId, setActiveCompanyId } from './secure-store';

// Which company within the active workspace every company-scoped request uses.
// The workspace (account) is the RLS tenant — pinned by `x-account-id`; a
// workspace can hold several companies, and the API takes a `companyId` per
// request and validates it belongs to the account. So "active company" is just
// which id the client sends — no header or RLS change. Mobile mirror of web's
// `active_company_id` cookie + `pickActiveCompany` (apps/web/src/lib/active-company.ts).
export type CompanyLite = { id: string; name: string };

// Honor the stored active company only when it's a company the account actually
// has — so a stale id (left from another workspace, or a deleted company)
// self-heals to the first company rather than scoping every read to nothing.
// Persists the resolved choice so the heal sticks. Returns undefined only for an
// empty list (the 0-company case the screens already guard as "no company").
// Generic over the element type so callers keep the full company shape they
// passed in (e.g. the hc-typed company with its show-on-invoice/estimate
// defaults), not a narrowed CompanyLite. Only `id` is used internally.
export async function pickActiveCompany<T extends CompanyLite>(
  companies: T[],
): Promise<T | undefined> {
  const first = companies[0];
  if (!first) return undefined;
  const stored = await getActiveCompanyId();
  const chosen = (stored ? companies.find((c) => c.id === stored) : undefined) ?? first;
  if (chosen.id !== stored) await setActiveCompanyId(chosen.id);
  return chosen;
}

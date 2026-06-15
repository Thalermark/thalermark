import { taxOfAmount } from '@thalermark/validation';

// Per-line tax helpers — the RN mirror of apps/web's $lib/line-tax. A line
// carries a `taxable` flag + a concrete tax-policy id; the rate comes from that
// policy. Mobile is a direct API client (no server action), so it computes the
// per-line taxRatePct + taxAmount itself and sends them — the same way it
// already computes `amount`. Keep this in lockstep with the web helper.

export type TaxPolicyLite = {
  id: string;
  name: string;
  ratePct: string;
  isDefault: boolean;
};

// The company default policy's id (the fallback for a newly-taxable or
// catalog-prefilled line), or '' when no default is set.
export function defaultPolicyId(policies: { id: string; isDefault: boolean }[]): string {
  return policies.find((p) => p.isDefault)?.id ?? '';
}

// The percent rate for a policy id, or '0' when the line isn't tied to a known
// policy (untaxed, or a stale/removed reference).
export function policyRate(policies: { id: string; ratePct: string }[], policyId: string): string {
  return policies.find((p) => p.id === policyId)?.ratePct ?? '0';
}

// The tax owed on one line: amount × the policy's rate, or zero when not
// taxable. Same rounding as the server (taxOfAmount, bigint half-away).
export function lineTax(taxable: boolean, ratePct: string, amount: string): string {
  return taxable ? taxOfAmount(amount, ratePct) : '0';
}

// Resolve a preferred policy id to a concrete, currently-active one — falls
// back to the company default (or the first policy) when the preference is
// empty or points at an archived/removed policy.
export function resolvePolicyId(policies: TaxPolicyLite[], pref: string): string {
  if (pref && policies.some((p) => p.id === pref)) return pref;
  return defaultPolicyId(policies) || policies[0]?.id || '';
}

import { taxOfAmount } from '@thalermark/validation';

// Per-line tax helpers shared by the invoice / estimate / recurring forms (live
// preview) and their server actions (authoritative recompute). A line carries a
// `taxable` flag + a concrete tax-policy id; the rate comes from that policy, so
// both client and server derive the same line tax from the same policy list —
// the displayed total can't drift from what's stored.

export type TaxPolicyLite = {
  id: string;
  name: string;
  ratePct: string;
  isDefault: boolean;
};

// The company default policy's id (the one a newly-taxable / catalog-prefilled
// line falls back to), or '' when no default is set.
export function defaultPolicyId(policies: { id: string; isDefault: boolean }[]): string {
  return policies.find((p) => p.isDefault)?.id ?? '';
}

// The percent rate for a policy id, or '0' when the line isn't tied to a known
// policy (untaxed, or a stale/removed reference).
export function policyRate(policies: { id: string; ratePct: string }[], policyId: string): string {
  return policies.find((p) => p.id === policyId)?.ratePct ?? '0';
}

// The tax owed on one line: amount × the policy's rate, or zero when the line
// isn't taxable. Same rounding as the server (taxOfAmount, bigint half-away).
export function lineTax(taxable: boolean, ratePct: string, amount: string): string {
  return taxable ? taxOfAmount(amount, ratePct) : '0';
}

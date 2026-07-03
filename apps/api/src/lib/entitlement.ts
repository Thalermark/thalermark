// The open-core entitlement seam. Core asks "may this account do X?" at every
// gated door; an injected provider answers. The community / self-host default
// (communityEntitlements) answers "yes" to everything — self-host is
// unrestricted, so the public build behaves exactly as it would with no seam at
// all. The commercial composition root (thalermark-cloud, out of this repo)
// injects a plan-aware provider that reads the account's plan/status and returns
// real answers; that private provider is the ONLY place a non-yes answer ever
// originates. Core never learns what the plans are — it only knows how to ask.
// See spikes/SAAS-AND-PRODUCTION.md §6.5 (and §8.3 for the five-door lock).

// The account a door is being asked about. An object rather than a bare id
// string so the provider can be handed more context later without touching every
// call site: core passes what the tenant context already has (the account id),
// and a plan-aware provider looks up everything else (plan, status, usage) in its
// own tables keyed by that id.
export type EntitlementAccount = { accountId: string };

// The gated capabilities. Deliberately tiny (§4: "resist inventing levers — the
// differentiator is AI; everything else is base"):
//   'ai'              — the AI layer: receipt extraction + insight generation.
//   'documents:write' — the freeze gate: creating or sending new billable work
//                       (invoices, estimates, expenses) and recurring
//                       generation. A frozen (lapsed) account loses this while
//                       keeping read + export on and already-sent invoices
//                       payable — freeze, not lock-out (§5).
export type Feature = 'ai' | 'documents:write';

// Metered quotas — the limit() half of the five-door lock (§8.3). Shaped from day
// one so the seam isn't refactored when a real meter lands, but nothing in core
// enforces a quota today: the community default returns Infinity for every one.
// Stays a bare string until the commercial provider names its keys (e.g. a
// managed-AI fair-use allowance).
export type Quota = string;

export interface EntitlementProvider {
  // May this account use this feature right now? Core gates the door; the
  // provider decides. Community default: always true.
  can(account: EntitlementAccount, feature: Feature): boolean;
  // This account's ceiling for a metered quota. Unused by core today; community
  // default: Infinity. Present so the interface is complete from the start and
  // cloud never has to widen it (which would force a core edit).
  limit(account: EntitlementAccount, quota: Quota): number;
}

// Self-host / community edition: everything unlocked. This IS what makes
// self-host free. The public composition root (apps/api/src/server.ts) injects
// this explicitly; routes and the recurring sweep fall back to it when no
// provider is wired (integration tests, embedders). It never returns false — a
// locked answer only ever comes from the commercial provider.
export const communityEntitlements: EntitlementProvider = {
  can: () => true,
  limit: () => Number.POSITIVE_INFINITY,
};

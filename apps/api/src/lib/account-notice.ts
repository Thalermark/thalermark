// The open-core account-notice seam. Web needs a slot to show a short notice — a
// message + a CTA link — to a logged-in account: in the managed deployment a
// frozen/lapsed tenant sees "Your trial has ended → Upgrade" linking out to the
// account dashboard. Core never learns what "frozen"/"trial"/"plan" mean — it
// only knows a provider MAY supply a notice for an account, and if one is present
// the web renders it. The community / self-host default (communityAccountNotices)
// returns null for every account, so the public build mounts no banner and behaves
// exactly as it would with no seam at all. The commercial composition root
// (thalermark-cloud, out of this repo) injects a plan-aware provider that returns
// the real notice; that private provider is the ONLY place a non-null notice ever
// originates.
//
// This seam renders in web but is injected API-side, exactly like the other three
// (entitlement, llm-credentials, onAccountCreated): the notice rides the existing
// GET /api/me response — one notice per membership row — so self-host makes zero
// extra network calls. /api/me returns all of a user's memberships before an
// active account is picked (the web hook selects the active one by cookie), so a
// per-membership notice is both the only clean spot and the tenancy-correct answer
// for a multi-account user. See spikes/ACCOUNT-NOTICE-SEAM.md.

// A short banner shown to a logged-in account. Neutral by design: core knows only
// "a message with a CTA link", never "upgrade"/"trial". `variant` maps onto the
// web design system's callout colours (accent for info, copper for warning).
export interface AccountNotice {
  message: string;
  ctaLabel: string;
  ctaHref: string;
  variant?: 'info' | 'warning';
}

export interface AccountNoticeProvider {
  // Given an account, return its current notice or null. Async so a plan-aware
  // provider can read its own tables keyed by accountId; the community default is
  // a trivial null. Called once per membership on each GET /api/me — a
  // multi-account user resolves a notice per account, and cloud caches its own
  // lookups.
  get(account: { accountId: string }): Promise<AccountNotice | null>;
}

// Self-host / community edition: no account ever has a notice. This IS what keeps
// the public build byte-identical — no banner mounts, no extra call is made. The
// public composition root (apps/api/src/server.ts) injects this explicitly; the
// /api/me handler falls back to it when no provider is wired (tests, embedders).
// It never returns non-null — a real notice only ever comes from the commercial
// provider.
export const communityAccountNotices: AccountNoticeProvider = {
  get: async () => null,
};

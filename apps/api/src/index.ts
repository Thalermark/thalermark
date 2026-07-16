// The public API of @thalermark/api — the single front door.
//
// A composition root (this app's server.ts, or the private commercial root) builds on
// exactly what this barrel re-exports; everything else in the package is internal. The
// package's `exports` map advertises only this entry, so a deep import like
// `@thalermark/api/src/bootstrap.js` is refused — core can move its internals around
// freely as long as the names below stay stable. Keep this list deliberate: adding an
// export widens the public contract, removing one is a breaking change for the
// commercial root.
//
// Side-effect-free: re-exporting app.ts/bootstrap.ts only defines things — importing
// `@thalermark/api` never starts a server (server.ts, the runnable entry, is not here).

// ── Core app: route mounting, the injection bag, and the RPC contract ──
export * from './app.js'; // createApp, AppDeps, AppType + the per-domain *AppType types
// ── Boot factory + lifecycle helpers ──
export * from './bootstrap.js'; // createDefaultAppDeps, BootHandles, CreateDefaultAppDepsOptions,
// MigrationPack, SweepJobDeps, registerCoreJobs, initObservability, runBootMigrations, installShutdown
// ── Env ──
export * from './env.js'; // loadEnv, Env, LogLevel, assertNoWeakSecretsInProduction
// NOTE: loadDotEnv is deliberately NOT re-exported here. It must be importable WITHOUT
// pulling this barrel's auth graph (importing the barrel evaluates bootstrap.ts →
// Better Auth, which captures NODE_ENV at import time). A preload module has to run
// loadDotEnv *before* that capture, so it lives on its own auth-free door,
// `@thalermark/api/preload` (→ env-file.ts). See load-env.ts for the ordering rationale.

// ── Open-core seams: interface, the types needed to implement it, and the community
//    default the commercial root swaps out ──
export {
  type EntitlementProvider,
  type EntitlementAccount,
  type Feature,
  type Quota,
  communityEntitlements,
} from './lib/entitlement.js';
export {
  type AccountNoticeProvider,
  type AccountNotice,
  communityAccountNotices,
} from './lib/account-notice.js';
export type { LlmCredentialResolver, LlmAccount } from './lib/llm-credentials.js';
export {
  type LlmConnectionReader,
  type LlmConnectionStore,
  createLlmConnectionStore,
  settingsLlmCredentials,
} from './lib/llm-connection.js';
export type { LegalConsentConfig } from './lib/legal-consent.js';
// The signup-lifecycle seam type lives in @thalermark/auth; re-export it so the
// commercial root gets it through this one door too.
export type { AccountCreatedContext } from '@thalermark/auth';
// The identity-provider seam config (single-login for dashboard/admin + MCP).
// Also lives in @thalermark/auth; surfaced here so the commercial root builds its
// trusted-client list against the one public door. Passed via
// CreateDefaultAppDepsOptions.idp.
export type { IdpOptions } from '@thalermark/auth';

// ── Provider / infrastructure constructors a composition root wires ──
export { type Mailer, createConsoleMailer, createResendMailer } from './lib/mailer.js';
export { type StripeBundle, createStripeBundle } from './lib/stripe.js';
export { type ApiAuth, createApiAuth, enabledSocialProviders } from './lib/auth.js';
export { type ApiDatabase, createApiDatabase } from './lib/db.js';
// Role provisioning: the generic promote-to-LOGIN plus the app-role wrapper. A
// commercial root promotes its own roles (provisionRole) and mirrors core's test
// setup (provisionAppRole); provisionPgBossRole stays internal — reached via
// runBootMigrations.
export { provisionAppRole, provisionRole } from './lib/role-provision.js';

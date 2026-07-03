import type { MiddlewareHandler } from 'hono';
import {
  type EntitlementProvider,
  type Feature,
  communityEntitlements,
} from '../lib/entitlement.js';
import type { RlsVariables } from './rls-context.js';

// Per-route plan-entitlement gate — the open-core seam's HTTP door. A sibling of
// requireCapability (middleware/authz.ts) on a different axis: capabilities
// answer "may this member do it inside the workspace" (role); entitlements
// answer "does this account's plan allow it at all" (billing). Both sit right on
// the route so a forgotten gate shows up in review. The provider is injected via
// deps; when omitted (self-host, tests) it resolves to communityEntitlements,
// which always says yes — so the public build is unrestricted.
//
// Applied after rlsContext has set `accountId`, so it reads the account from
// context. On denial it returns 402 Payment Required (distinct from 403
// forbidden) with the feature name — a locked account needs to pay/upgrade, not
// to be told its role is wrong. In core this branch is unreachable (community
// always allows); the commercial web renders it as an upgrade / unfreeze prompt.
export function requireEntitlement(
  deps: { entitlement?: EntitlementProvider },
  feature: Feature,
): MiddlewareHandler<{ Variables: RlsVariables }> {
  const entitlement = deps.entitlement ?? communityEntitlements;
  return async (c, next) => {
    if (!entitlement.can({ accountId: c.get('accountId') }, feature)) {
      return c.json({ error: 'not_entitled', feature }, 402);
    }
    await next();
  };
}

import type { AppType, ItemsAppType, TaxPoliciesAppType } from '@thalermark/api-contract';
import { hc } from 'hono/client';
import { getActiveAccountId, getAuthToken } from './secure-store';
import { getServerUrl } from './server-url';

// Mobile-side mirror of apps/web's `src/lib/api.ts`. The web client uses
// cookies (`credentials: 'include'`); mobile uses the bearer token written
// to expo-secure-store by `auth-client.ts` on sign-in/sign-up. Origin is
// pinned to the app scheme for parity with the auth-client — apps/api's
// TRUSTED_ORIGINS allowlist + BA's formCsrfMiddleware both require it.
const APP_ORIGIN = 'thalermark://';

// The per-request headers every typed client stamps: Origin (CSRF/TRUSTED_ORIGINS)
// + the bearer token + x-account-id. Shared so the second RPC surface (bills-api.ts,
// hc<BillsAppType>) sends the identical contract without re-deriving it.
//
// `x-account-id` scopes every tenant route to the active membership — the mobile
// equivalent of web's `active_account_id` cookie → `x-account-id` stamping
// (apps/web/src/lib/api.server.ts). Bootstrap routes (/api/me, invite-accept)
// ignore it; tenant routes 400 without it. Absent until an active account is
// resolved (see active-account.ts) — the only call before that is /api/me, which
// is a bootstrap route.
export async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAuthToken();
  const base: Record<string, string> = { Origin: APP_ORIGIN };
  if (token) base.Authorization = `Bearer ${token}`;
  const accountId = await getActiveAccountId();
  if (accountId) base['x-account-id'] = accountId;
  return base;
}

// Per-domain RPC surfaces. Items + tax-policies are kept out of AppType to stay
// under the TS type-serialization ceiling (TS7056 — see apps/api/src/app.ts);
// they live on their own hc clients but are composed back behind the single
// `api` export so call sites stay `api.api.<domain>`. All three share authHeaders
// and the same base URL — the runtime is one server, so the split is type-only.
function buildClients(baseUrl: string) {
  return {
    main: hc<AppType>(baseUrl, { headers: authHeaders }),
    items: hc<ItemsAppType>(baseUrl, { headers: authHeaders }),
    taxPolicies: hc<TaxPoliciesAppType>(baseUrl, { headers: authHeaders }),
  };
}

// The base URL is chosen at runtime (server picker — see server-url.ts), but
// hc captures it at construction. So we memoize the clients and rebuild them
// whenever the configured URL changes. `api` stays a stable export — a Proxy
// that forwards to the live clients — so the call sites (`api.api.contacts…`)
// never need to know the URL can change.
let clients = buildClients(getServerUrl());
let builtFor = getServerUrl();

function liveClients() {
  const url = getServerUrl();
  if (url !== builtFor) {
    clients = buildClients(url);
    builtFor = url;
  }
  return clients;
}

// The unified `.api` surface: the migrated domains (items, tax-policies) route
// to their own client, everything else to the main client. As more domains
// migrate they join the override map — call sites never change.
function facadeApi() {
  const { main, items, taxPolicies } = liveClients();
  const overrides: Record<string, unknown> = {
    items: items.api.items,
    'tax-policies': taxPolicies.api['tax-policies'],
  };
  return new Proxy(main.api, {
    get(target, prop) {
      if (typeof prop === 'string' && prop in overrides) return overrides[prop];
      return Reflect.get(target, prop);
    },
  });
}

type MainApi = ReturnType<typeof buildClients>['main']['api'];
type ItemsApi = ReturnType<typeof buildClients>['items']['api'];
type TaxPoliciesApi = ReturnType<typeof buildClients>['taxPolicies']['api'];
type ApiClient = {
  api: MainApi & { items: ItemsApi['items']; 'tax-policies': TaxPoliciesApi['tax-policies'] };
};

export const api = new Proxy({} as ApiClient, {
  get: (_target, prop) => {
    if (prop === 'api') return facadeApi();
    return (liveClients().main as Record<string | symbol, unknown>)[prop];
  },
});

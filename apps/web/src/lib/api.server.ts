import { env as privateEnv } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import type { RequestEvent } from '@sveltejs/kit';
import type {
  AppType,
  AuditEventsAppType,
  BillsAppType,
  ContactsAppType,
  ItemsAppType,
  TaxPoliciesAppType,
} from '@thalermark/api-contract';
import { hc } from 'hono/client';

// SSR fetches need an absolute URL. Mirrors hooks.server.ts — `||` not `??` so
// an explicit empty PUBLIC_API_URL (the self-host default, where the browser
// uses relative /api/*) falls through to the internal compose hostname.
const baseUrl = () =>
  privateEnv.INTERNAL_API_URL || publicEnv.PUBLIC_API_URL || 'http://localhost:3000';

// Name each per-domain client's `.api` surface without constructing a runtime
// instance (Hono's recommended trick: a wrapper fn whose ReturnType is the
// client type). The migrated domains (apps/api/src/routes/*) live on their own
// RPC surfaces, kept out of AppType so no single combined type is ever
// serialized (the TS7056 ceiling the modular sub-apps dodge — see app.ts).
const mkMain = (...a: Parameters<typeof hc>) => hc<AppType>(...a);
const mkItems = (...a: Parameters<typeof hc>) => hc<ItemsAppType>(...a);
const mkTaxPolicies = (...a: Parameters<typeof hc>) => hc<TaxPoliciesAppType>(...a);
const mkAuditEvents = (...a: Parameters<typeof hc>) => hc<AuditEventsAppType>(...a);
const mkContacts = (...a: Parameters<typeof hc>) => hc<ContactsAppType>(...a);
type MainApi = ReturnType<typeof mkMain>['api'];
type ItemsApi = ReturnType<typeof mkItems>['api'];
type TaxPoliciesApi = ReturnType<typeof mkTaxPolicies>['api'];
type AuditEventsApi = ReturnType<typeof mkAuditEvents>['api'];
type ContactsApi = ReturnType<typeof mkContacts>['api'];

// The unified server RPC client. Call sites still reach every domain as
// client.api.<domain>; a Proxy routes the migrated domains to their own hc
// client and everything else to the main client. As more domains migrate they
// join the override map below — call sites never change. The runtime is one
// server (createApp mounts every sub-app), so the split is purely type-level.
export type ServerApiClient = {
  api: MainApi & {
    items: ItemsApi['items'];
    'tax-policies': TaxPoliciesApi['tax-policies'];
    'audit-events': AuditEventsApi['audit-events'];
    contacts: ContactsApi['contacts'];
  };
};

// Server-side hc client. Forwards the BA session cookie from the incoming
// request and stamps x-account-id from locals.activeAccountId (set by
// hooks.server.ts). The browser client at $lib/api.ts is the cookie-jar
// equivalent for client-side calls.
export function serverApiClient(event: RequestEvent): ServerApiClient {
  const headers = serverApiHeaders(event);
  const base = baseUrl();
  const main = hc<AppType>(base, { headers });
  const overrides: Record<string, unknown> = {
    items: hc<ItemsAppType>(base, { headers }).api.items,
    'tax-policies': hc<TaxPoliciesAppType>(base, { headers }).api['tax-policies'],
    'audit-events': hc<AuditEventsAppType>(base, { headers }).api['audit-events'],
    contacts: hc<ContactsAppType>(base, { headers }).api.contacts,
  };
  const api = new Proxy(main.api, {
    get(target, prop) {
      if (typeof prop === 'string' && prop in overrides) return overrides[prop];
      return Reflect.get(target, prop);
    },
  }) as ServerApiClient['api'];
  return { api };
}

// Bills (accounts payable) live on a second RPC surface (BillsAppType) — kept
// out of AppType to stay under the TS type-serialization ceiling. Same auth
// headers; just a different typed client over the same api origin. (Folds into
// the facade above once the bills domain is migrated to a routes/ sub-app.)
export function serverBillsApiClient(event: RequestEvent) {
  return hc<BillsAppType>(baseUrl(), { headers: serverApiHeaders(event) });
}

// Absolute api base for the rare server-side call that can't go through the
// typed client — e.g. forwarding a multipart receipt upload, where the hc
// client has no typed `form` surface for the route.
export function apiBaseUrl(): string {
  return baseUrl();
}

// The same auth headers serverApiClient stamps (BA session cookie +
// x-account-id), for use with a raw fetch. Deliberately omits content-type so
// the caller's body (e.g. FormData) sets its own multipart boundary.
export function serverApiHeaders(event: RequestEvent): Record<string, string> {
  const headers: Record<string, string> = {};
  const cookie = event.request.headers.get('cookie');
  if (cookie) headers.cookie = cookie;
  if (event.locals.activeAccountId) headers['x-account-id'] = event.locals.activeAccountId;
  return headers;
}

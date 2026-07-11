import { env as privateEnv } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import type { RequestEvent } from '@sveltejs/kit';
import type {
  AccountAppType,
  AppType,
  AuditEventsAppType,
  BillsAppType,
  CompaniesAppType,
  ContactsAppType,
  EstimatesAppType,
  ExpensesAppType,
  InvoicesAppType,
  ItemsAppType,
  LedgerAppType,
  OwnerMoneyEventsAppType,
  PurchasesAppType,
  RecurringInvoicesAppType,
  ReportsAppType,
  SettingsAiAppType,
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
const mkAccount = (...a: Parameters<typeof hc>) => hc<AccountAppType>(...a);
const mkBills = (...a: Parameters<typeof hc>) => hc<BillsAppType>(...a);
const mkOwnerMoney = (...a: Parameters<typeof hc>) => hc<OwnerMoneyEventsAppType>(...a);
const mkPurchases = (...a: Parameters<typeof hc>) => hc<PurchasesAppType>(...a);
const mkLedger = (...a: Parameters<typeof hc>) => hc<LedgerAppType>(...a);
const mkItems = (...a: Parameters<typeof hc>) => hc<ItemsAppType>(...a);
const mkTaxPolicies = (...a: Parameters<typeof hc>) => hc<TaxPoliciesAppType>(...a);
const mkAuditEvents = (...a: Parameters<typeof hc>) => hc<AuditEventsAppType>(...a);
const mkCompanies = (...a: Parameters<typeof hc>) => hc<CompaniesAppType>(...a);
const mkContacts = (...a: Parameters<typeof hc>) => hc<ContactsAppType>(...a);
const mkInvoices = (...a: Parameters<typeof hc>) => hc<InvoicesAppType>(...a);
const mkRecurring = (...a: Parameters<typeof hc>) => hc<RecurringInvoicesAppType>(...a);
const mkEstimates = (...a: Parameters<typeof hc>) => hc<EstimatesAppType>(...a);
const mkExpenses = (...a: Parameters<typeof hc>) => hc<ExpensesAppType>(...a);
const mkReports = (...a: Parameters<typeof hc>) => hc<ReportsAppType>(...a);
const mkSettingsAi = (...a: Parameters<typeof hc>) => hc<SettingsAiAppType>(...a);
type MainApi = ReturnType<typeof mkMain>['api'];
type AccountApi = ReturnType<typeof mkAccount>['api'];
type BillsApi = ReturnType<typeof mkBills>['api'];
type OwnerMoneyApi = ReturnType<typeof mkOwnerMoney>['api'];
type PurchasesApi = ReturnType<typeof mkPurchases>['api'];
type LedgerApi = ReturnType<typeof mkLedger>['api'];
type ItemsApi = ReturnType<typeof mkItems>['api'];
type TaxPoliciesApi = ReturnType<typeof mkTaxPolicies>['api'];
type AuditEventsApi = ReturnType<typeof mkAuditEvents>['api'];
type CompaniesApi = ReturnType<typeof mkCompanies>['api'];
type ContactsApi = ReturnType<typeof mkContacts>['api'];
type InvoicesApi = ReturnType<typeof mkInvoices>['api'];
type RecurringApi = ReturnType<typeof mkRecurring>['api'];
type EstimatesApi = ReturnType<typeof mkEstimates>['api'];
type ExpensesApi = ReturnType<typeof mkExpenses>['api'];
type ReportsApi = ReturnType<typeof mkReports>['api'];
type SettingsAiApi = ReturnType<typeof mkSettingsAi>['api'];

// The unified server RPC client. Call sites still reach every domain as
// client.api.<domain>; a Proxy routes the migrated domains to their own hc
// client and everything else to the main client. As more domains migrate they
// join the override map below — call sites never change. The runtime is one
// server (createApp mounts every sub-app), so the split is purely type-level.
// `companies` is a split-prefix domain: the CRUD / settings / logo /
// stripe-connect / ledger-export / accounts routes live on CompaniesAppType,
// while the company-scoped REPORTS + AI insights (`/api/companies/:id/dashboard`,
// `/profit-loss`, `/cash-flow-nudges`, …) live on ReportsAppType — both under
// the same `/api/companies/:id` prefix. So `companies` is the *intersection* of
// the two sub-app surfaces: TS merges the same-key object types, and the runtime
// hc client is a URL builder so the single override client reaches both halves'
// paths. (AppType no longer carries any `/api/companies` route.)
export type ServerApiClient = {
  api: MainApi & {
    // account sub-app serves four prefixes; web consumes me/account/team via hc
    // (invitations create/accept/decline go through raw fetch in the (auth) flow,
    // so no `invitations` override here — see settings/team + select-company).
    me: AccountApi['me'];
    account: AccountApi['account'];
    team: AccountApi['team'];
    bills: BillsApi['bills'];
    'owner-money': OwnerMoneyApi['owner-money'];
    purchases: PurchasesApi['purchases'];
    ledger: LedgerApi['ledger'];
    items: ItemsApi['items'];
    'tax-policies': TaxPoliciesApi['tax-policies'];
    'audit-events': AuditEventsApi['audit-events'];
    companies: CompaniesApi['companies'] & ReportsApi['companies'];
    contacts: ContactsApi['contacts'];
    invoices: InvoicesApi['invoices'];
    'recurring-invoices': RecurringApi['recurring-invoices'];
    estimates: EstimatesApi['estimates'];
    expenses: ExpensesApi['expenses'];
    settings: SettingsAiApi['settings'];
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
  const accountApi = hc<AccountAppType>(base, { headers }).api;
  const overrides: Record<string, unknown> = {
    me: accountApi.me,
    account: accountApi.account,
    team: accountApi.team,
    bills: hc<BillsAppType>(base, { headers }).api.bills,
    'owner-money': hc<OwnerMoneyEventsAppType>(base, { headers }).api['owner-money'],
    purchases: hc<PurchasesAppType>(base, { headers }).api.purchases,
    ledger: hc<LedgerAppType>(base, { headers }).api.ledger,
    items: hc<ItemsAppType>(base, { headers }).api.items,
    'tax-policies': hc<TaxPoliciesAppType>(base, { headers }).api['tax-policies'],
    'audit-events': hc<AuditEventsAppType>(base, { headers }).api['audit-events'],
    companies: hc<CompaniesAppType>(base, { headers }).api.companies,
    contacts: hc<ContactsAppType>(base, { headers }).api.contacts,
    invoices: hc<InvoicesAppType>(base, { headers }).api.invoices,
    'recurring-invoices': hc<RecurringInvoicesAppType>(base, { headers }).api['recurring-invoices'],
    estimates: hc<EstimatesAppType>(base, { headers }).api.estimates,
    expenses: hc<ExpensesAppType>(base, { headers }).api.expenses,
    settings: hc<SettingsAiAppType>(base, { headers }).api.settings,
  };
  const api = new Proxy(main.api, {
    get(target, prop) {
      if (typeof prop === 'string' && prop in overrides) return overrides[prop];
      return Reflect.get(target, prop);
    },
  }) as ServerApiClient['api'];
  return { api };
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

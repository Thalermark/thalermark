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
  LocationsAppType,
  OwnerMoneyEventsAppType,
  PurchasesAppType,
  RecurringInvoicesAppType,
  ReportsAppType,
  SocialProvidersAppType,
  TaxPoliciesAppType,
  TelemetryAppType,
} from '@thalermark/api-contract';
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
// + the bearer token + x-account-id. Shared by every per-domain client in
// buildClients so they all send the identical contract without re-deriving it.
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

// Per-domain RPC surfaces. The migrated domains (apps/api/src/routes/*) are kept
// out of AppType to stay under the TS type-serialization ceiling (TS7056 — see
// apps/api/src/app.ts); they live on their own hc clients but are composed back
// behind the single `api` export so call sites stay `api.api.<domain>`. As more
// domains migrate they join the map below. All share authHeaders and the same base
// URL — the runtime is one server, so the split is type-only.
function buildClients(baseUrl: string) {
  return {
    main: hc<AppType>(baseUrl, { headers: authHeaders }),
    items: hc<ItemsAppType>(baseUrl, { headers: authHeaders }),
    taxPolicies: hc<TaxPoliciesAppType>(baseUrl, { headers: authHeaders }),
    socialProviders: hc<SocialProvidersAppType>(baseUrl, { headers: authHeaders }),
    locations: hc<LocationsAppType>(baseUrl, { headers: authHeaders }),
    auditEvents: hc<AuditEventsAppType>(baseUrl, { headers: authHeaders }),
    telemetry: hc<TelemetryAppType>(baseUrl, { headers: authHeaders }),
    account: hc<AccountAppType>(baseUrl, { headers: authHeaders }),
    bills: hc<BillsAppType>(baseUrl, { headers: authHeaders }),
    ownerMoney: hc<OwnerMoneyEventsAppType>(baseUrl, { headers: authHeaders }),
    purchases: hc<PurchasesAppType>(baseUrl, { headers: authHeaders }),
    ledger: hc<LedgerAppType>(baseUrl, { headers: authHeaders }),
    companies: hc<CompaniesAppType>(baseUrl, { headers: authHeaders }),
    contacts: hc<ContactsAppType>(baseUrl, { headers: authHeaders }),
    invoices: hc<InvoicesAppType>(baseUrl, { headers: authHeaders }),
    recurringInvoices: hc<RecurringInvoicesAppType>(baseUrl, { headers: authHeaders }),
    estimates: hc<EstimatesAppType>(baseUrl, { headers: authHeaders }),
    expenses: hc<ExpensesAppType>(baseUrl, { headers: authHeaders }),
    // reports is type-only here: its routes live under /api/companies/:id/*, so
    // they're served at runtime by the `companies` override below (hc is a URL
    // builder). This client exists to derive ReportsApi for the intersection.
    reports: hc<ReportsAppType>(baseUrl, { headers: authHeaders }),
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

// The unified `.api` surface: the migrated domains route to their own client,
// everything else to the main client. As more domains migrate they join the
// override map — call sites never change.
function facadeApi() {
  const {
    main,
    items,
    taxPolicies,
    socialProviders,
    locations,
    auditEvents,
    telemetry,
    account,
    bills,
    ownerMoney,
    purchases,
    ledger,
    companies,
    contacts,
    invoices,
    recurringInvoices,
    estimates,
    expenses,
  } = liveClients();
  const overrides: Record<string, unknown> = {
    items: items.api.items,
    'tax-policies': taxPolicies.api['tax-policies'],
    'social-providers': socialProviders.api['social-providers'],
    locations: locations.api.locations,
    'audit-events': auditEvents.api['audit-events'],
    telemetry: telemetry.api.telemetry,
    me: account.api.me,
    account: account.api.account,
    invitations: account.api.invitations,
    team: account.api.team,
    legal: account.api.legal,
    bills: bills.api.bills,
    'owner-money': ownerMoney.api['owner-money'],
    purchases: purchases.api.purchases,
    ledger: ledger.api.ledger,
    companies: companies.api.companies,
    contacts: contacts.api.contacts,
    invoices: invoices.api.invoices,
    'recurring-invoices': recurringInvoices.api['recurring-invoices'],
    estimates: estimates.api.estimates,
    expenses: expenses.api.expenses,
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
type SocialProvidersApi = ReturnType<typeof buildClients>['socialProviders']['api'];
type LocationsApi = ReturnType<typeof buildClients>['locations']['api'];
type AuditEventsApi = ReturnType<typeof buildClients>['auditEvents']['api'];
type TelemetryApi = ReturnType<typeof buildClients>['telemetry']['api'];
type AccountApi = ReturnType<typeof buildClients>['account']['api'];
type BillsApi = ReturnType<typeof buildClients>['bills']['api'];
type OwnerMoneyApi = ReturnType<typeof buildClients>['ownerMoney']['api'];
type PurchasesApi = ReturnType<typeof buildClients>['purchases']['api'];
type LedgerApi = ReturnType<typeof buildClients>['ledger']['api'];
type CompaniesApi = ReturnType<typeof buildClients>['companies']['api'];
type ContactsApi = ReturnType<typeof buildClients>['contacts']['api'];
type InvoicesApi = ReturnType<typeof buildClients>['invoices']['api'];
type RecurringApi = ReturnType<typeof buildClients>['recurringInvoices']['api'];
type EstimatesApi = ReturnType<typeof buildClients>['estimates']['api'];
type ExpensesApi = ReturnType<typeof buildClients>['expenses']['api'];
type ReportsApi = ReturnType<typeof buildClients>['reports']['api'];
type ApiClient = {
  api: MainApi & {
    items: ItemsApi['items'];
    'tax-policies': TaxPoliciesApi['tax-policies'];
    'social-providers': SocialProvidersApi['social-providers'];
    locations: LocationsApi['locations'];
    'audit-events': AuditEventsApi['audit-events'];
    telemetry: TelemetryApi['telemetry'];
    // account sub-app: four workspace prefixes (mobile consumes all via hc).
    me: AccountApi['me'];
    account: AccountApi['account'];
    invitations: AccountApi['invitations'];
    team: AccountApi['team'];
    legal: AccountApi['legal'];
    bills: BillsApi['bills'];
    'owner-money': OwnerMoneyApi['owner-money'];
    purchases: PurchasesApi['purchases'];
    ledger: LedgerApi['ledger'];
    // Split-prefix domain: company CRUD / settings / logo / accounts on
    // CompaniesAppType, the company-scoped reports + AI insights on
    // ReportsAppType — both under /api/companies/:id. Intersect both surfaces so
    // call sites reach either half; the `companies` override serves both at
    // runtime (hc is a URL builder). AppType no longer carries /api/companies.
    companies: CompaniesApi['companies'] & ReportsApi['companies'];
    contacts: ContactsApi['contacts'];
    invoices: InvoicesApi['invoices'];
    'recurring-invoices': RecurringApi['recurring-invoices'];
    estimates: EstimatesApi['estimates'];
    expenses: ExpensesApi['expenses'];
  };
};

export const api = new Proxy({} as ApiClient, {
  get: (_target, prop) => {
    if (prop === 'api') return facadeApi();
    return (liveClients().main as Record<string | symbol, unknown>)[prop];
  },
});

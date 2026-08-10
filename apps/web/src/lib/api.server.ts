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
  EntityTransferAppType,
  EstimatesAppType,
  ExpensesAppType,
  InvoicesAppType,
  ItemsAppType,
  JobsAppType,
  LedgerAppType,
  MileageAppType,
  OwnerMoneyEventsAppType,
  PurchasesAppType,
  RecurringInvoicesAppType,
  ReportsAppType,
  SearchAppType,
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
const mkJobs = (...a: Parameters<typeof hc>) => hc<JobsAppType>(...a);
const mkMileage = (...a: Parameters<typeof hc>) => hc<MileageAppType>(...a);
const mkTaxPolicies = (...a: Parameters<typeof hc>) => hc<TaxPoliciesAppType>(...a);
const mkAuditEvents = (...a: Parameters<typeof hc>) => hc<AuditEventsAppType>(...a);
const mkCompanies = (...a: Parameters<typeof hc>) => hc<CompaniesAppType>(...a);
const mkContacts = (...a: Parameters<typeof hc>) => hc<ContactsAppType>(...a);
const mkInvoices = (...a: Parameters<typeof hc>) => hc<InvoicesAppType>(...a);
const mkRecurring = (...a: Parameters<typeof hc>) => hc<RecurringInvoicesAppType>(...a);
const mkEstimates = (...a: Parameters<typeof hc>) => hc<EstimatesAppType>(...a);
const mkExpenses = (...a: Parameters<typeof hc>) => hc<ExpensesAppType>(...a);
const mkReports = (...a: Parameters<typeof hc>) => hc<ReportsAppType>(...a);
const mkSearch = (...a: Parameters<typeof hc>) => hc<SearchAppType>(...a);
const mkSettingsAi = (...a: Parameters<typeof hc>) => hc<SettingsAiAppType>(...a);
const mkEntityTransfer = (...a: Parameters<typeof hc>) => hc<EntityTransferAppType>(...a);
type MainApi = ReturnType<typeof mkMain>['api'];
type AccountApi = ReturnType<typeof mkAccount>['api'];
type BillsApi = ReturnType<typeof mkBills>['api'];
type OwnerMoneyApi = ReturnType<typeof mkOwnerMoney>['api'];
type PurchasesApi = ReturnType<typeof mkPurchases>['api'];
type LedgerApi = ReturnType<typeof mkLedger>['api'];
type ItemsApi = ReturnType<typeof mkItems>['api'];
type JobsApi = ReturnType<typeof mkJobs>['api'];
type MileageApi = ReturnType<typeof mkMileage>['api'];
type TaxPoliciesApi = ReturnType<typeof mkTaxPolicies>['api'];
type AuditEventsApi = ReturnType<typeof mkAuditEvents>['api'];
type CompaniesApi = ReturnType<typeof mkCompanies>['api'];
type ContactsApi = ReturnType<typeof mkContacts>['api'];
type InvoicesApi = ReturnType<typeof mkInvoices>['api'];
type RecurringApi = ReturnType<typeof mkRecurring>['api'];
type EstimatesApi = ReturnType<typeof mkEstimates>['api'];
type ExpensesApi = ReturnType<typeof mkExpenses>['api'];
type ReportsApi = ReturnType<typeof mkReports>['api'];
type SearchApi = ReturnType<typeof mkSearch>['api'];
type SettingsAiApi = ReturnType<typeof mkSettingsAi>['api'];
type EntityTransferApi = ReturnType<typeof mkEntityTransfer>['api'];

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
//
// Two is the limit that works: a third same-key surface made hc's inference on
// the companies collection collapse to the bare constraint, which is why the
// incorporation handoff lives on its own `/api/entity-transfers` prefix.
export type ServerApiClient = {
  api: MainApi & {
    // account sub-app serves four prefixes; web consumes me/account/team via hc
    // (invitations create/accept/decline go through raw fetch in the (auth) flow,
    // so no `invitations` override here — see settings/team + select-company).
    me: AccountApi['me'];
    account: AccountApi['account'];
    team: AccountApi['team'];
    // Legal-consent state + accept, also on the account sub-app. Consumed by the
    // (app) layout load (state) and the legal-accept proxy (accept).
    legal: AccountApi['legal'];
    bills: BillsApi['bills'];
    'owner-money': OwnerMoneyApi['owner-money'];
    purchases: PurchasesApi['purchases'];
    ledger: LedgerApi['ledger'];
    items: ItemsApi['items'];
    jobs: JobsApi['jobs'];
    // Time entries live under /api/time-entries, not /api/jobs, so the same
    // sub-app surfaces two keys here.
    'time-entries': JobsApi['time-entries'];
    timer: JobsApi['timer'];
    'mileage-trips': MileageApi['mileage-trips'];
    vehicles: MileageApi['vehicles'];
    'tax-policies': TaxPoliciesApi['tax-policies'];
    'audit-events': AuditEventsApi['audit-events'];
    // Three sub-apps serve /api/companies/:id/* — companies itself, reports, and
    // the mileage year summary — so the facade key is their intersection.
    companies: CompaniesApi['companies'] & ReportsApi['companies'] & MileageApi['companies'];
    'entity-transfers': EntityTransferApi['entity-transfers'];
    contacts: ContactsApi['contacts'];
    invoices: InvoicesApi['invoices'];
    'recurring-invoices': RecurringApi['recurring-invoices'];
    estimates: EstimatesApi['estimates'];
    expenses: ExpensesApi['expenses'];
    search: SearchApi['search'];
    settings: SettingsAiApi['settings'];
  };
};

// A fetch that cannot reject (TMC-248).
//
// `if (!res.ok)` is the shape of every call site, and it only runs when the
// fetch RESOLVED. An unreachable API — a restart, a deploy, a network blip —
// makes fetch REJECT instead, and none of those call sites had a try/catch: 5
// of 60 action files did. So the action threw, SvelteKit rendered its error
// page, and the `values` object every action carefully builds to hand a user's
// input back was never returned. Someone who had just keyed in twelve invoice
// lines lost them to a ten-second API restart.
//
// Turning the rejection into a 503 whose body is a normal error code means the
// existing branch handles it, on every screen, without a single call site
// changing: a load still throws its error page (there is nothing to lose), and
// an action still `fail()`s with the user's values and a sentence.
//
// Deliberately NOT a retry. A retry here would hold the request open and hide
// the failure; the honest move is to say so immediately and leave the user's
// work on screen, with the Save button they already know how to press.
const UNREACHABLE_BODY = JSON.stringify({ error: 'unreachable' });

function unreachable(): Response {
  // A transport failure, not an HTTP one: DNS, refused connection, reset socket,
  // TLS. 503 because the service is what is unavailable — the request itself was
  // fine and is worth repeating.
  return new Response(UNREACHABLE_BODY, {
    status: 503,
    headers: { 'content-type': 'application/json' },
  });
}

const resilientFetch: typeof fetch = async (input, init) => {
  try {
    return await fetch(input, init);
  } catch {
    return unreachable();
  }
};

// The same guarantee for the handful of routes that cannot use the typed client
// — a multipart receipt, the invitation endpoints — so a dead API is one shape
// everywhere rather than two. `impl` keeps SvelteKit's `event.fetch` where a
// caller was using it, since that carries behaviour a bare fetch does not.
export async function apiFetch(
  input: string,
  init?: RequestInit,
  impl: typeof fetch = fetch,
): Promise<Response> {
  try {
    return await impl(input, init);
  } catch {
    return unreachable();
  }
}

// Server-side hc client. Forwards the BA session cookie from the incoming
// request and stamps x-account-id from locals.activeAccountId (set by
// hooks.server.ts). The browser client at $lib/api.ts is the cookie-jar
// equivalent for client-side calls.
export function serverApiClient(event: RequestEvent): ServerApiClient {
  const headers = serverApiHeaders(event);
  const base = baseUrl();
  const main = hc<AppType>(base, { headers, fetch: resilientFetch });
  const accountApi = hc<AccountAppType>(base, { headers, fetch: resilientFetch }).api;
  const overrides: Record<string, unknown> = {
    me: accountApi.me,
    account: accountApi.account,
    team: accountApi.team,
    legal: accountApi.legal,
    bills: hc<BillsAppType>(base, { headers, fetch: resilientFetch }).api.bills,
    'owner-money': hc<OwnerMoneyEventsAppType>(base, { headers, fetch: resilientFetch }).api[
      'owner-money'
    ],
    purchases: hc<PurchasesAppType>(base, { headers, fetch: resilientFetch }).api.purchases,
    ledger: hc<LedgerAppType>(base, { headers, fetch: resilientFetch }).api.ledger,
    items: hc<ItemsAppType>(base, { headers, fetch: resilientFetch }).api.items,
    jobs: hc<JobsAppType>(base, { headers, fetch: resilientFetch }).api.jobs,
    // Time entries hang off /api/time-entries rather than under /api/jobs, so
    // the facade needs both keys from the same sub-app.
    'time-entries': hc<JobsAppType>(base, { headers, fetch: resilientFetch }).api['time-entries'],
    // The running-stopwatch read hangs off its own top-level path, so the
    // facade needs a third key from the same sub-app.
    timer: hc<JobsAppType>(base, { headers, fetch: resilientFetch }).api.timer,
    'mileage-trips': hc<MileageAppType>(base, { headers, fetch: resilientFetch }).api[
      'mileage-trips'
    ],
    vehicles: hc<MileageAppType>(base, { headers, fetch: resilientFetch }).api.vehicles,
    'tax-policies': hc<TaxPoliciesAppType>(base, { headers, fetch: resilientFetch }).api[
      'tax-policies'
    ],
    'audit-events': hc<AuditEventsAppType>(base, { headers, fetch: resilientFetch }).api[
      'audit-events'
    ],
    companies: hc<CompaniesAppType>(base, { headers, fetch: resilientFetch }).api.companies,
    contacts: hc<ContactsAppType>(base, { headers, fetch: resilientFetch }).api.contacts,
    invoices: hc<InvoicesAppType>(base, { headers, fetch: resilientFetch }).api.invoices,
    'recurring-invoices': hc<RecurringInvoicesAppType>(base, { headers, fetch: resilientFetch })
      .api['recurring-invoices'],
    estimates: hc<EstimatesAppType>(base, { headers, fetch: resilientFetch }).api.estimates,
    expenses: hc<ExpensesAppType>(base, { headers, fetch: resilientFetch }).api.expenses,
    search: hc<SearchAppType>(base, { headers, fetch: resilientFetch }).api.search,
    settings: hc<SettingsAiAppType>(base, { headers, fetch: resilientFetch }).api.settings,
    'entity-transfers': hc<EntityTransferAppType>(base, { headers, fetch: resilientFetch }).api[
      'entity-transfers'
    ],
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

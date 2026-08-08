// Re-export point for the Hono RPC schema. Web + mobile import these types
// from here rather than from @thalermark/api directly so the api app can
// refactor its internals without breaking either client. Type-only — there
// is no runtime entry point because the api app is the runtime.
//
// Per-domain RPC surfaces: the api is being carved into modular sub-apps
// (apps/api/src/routes/*), each mounted at runtime in createApp but kept out of
// AppType so no single combined type is ever serialized (the root cause of the
// TS type-serialization ceiling, TS7056). Each domain exposes its own XAppType;
// clients build a dedicated hc<XAppType>() per domain and compose them behind a
// unified facade. AppType still carries every not-yet-migrated domain.
// The files sub-app (GET /api/files/:token) is intentionally absent: it's served
// by a signed URL hit directly (img src / download), never through a typed hc
// client, so no consumer needs its type. It's mounted at runtime in createApp
// like every other sub-app; its surface just isn't part of the RPC contract.
export type {
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
  LocationsAppType,
  MileageAppType,
  OwnerMoneyEventsAppType,
  PurchasesAppType,
  RecurringInvoicesAppType,
  ReportsAppType,
  SearchAppType,
  SettingsAiAppType,
  SocialProvidersAppType,
  TaxPoliciesAppType,
  TelemetryAppType,
} from '@thalermark/api/contract';

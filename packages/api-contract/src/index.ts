// Re-export point for the Hono RPC schema. Web + mobile import AppType
// from here rather than from @thalermark/api directly so the api app can
// refactor its internals without breaking either client. Type-only — there
// is no runtime entry point because the api app is the runtime.
// BillsAppType is a second RPC surface: the bills (accounts payable) routes are
// mounted at runtime in createApp but kept out of AppType to stay under the
// TypeScript type-serialization ceiling (TS7056). Clients build a dedicated
// hc<BillsAppType>() for /api/bills* alongside the main hc<AppType>() client.
export type { AppType, BillsAppType } from '@thalermark/api';

// Re-export point for the Hono RPC schema. Web + mobile import AppType
// from here rather than from @thalermark/api directly so the api app can
// refactor its internals without breaking either client. Type-only — there
// is no runtime entry point because the api app is the runtime.
export type { AppType } from '@thalermark/api';

import type { BillsAppType } from '@thalermark/api-contract';
import { hc } from 'hono/client';
import { authHeaders } from './api';
import { getServerUrl } from './server-url';

// Bills (accounts payable) live on a SECOND RPC surface — kept out of AppType to
// stay under the TypeScript type-serialization ceiling (TS7056). This is the
// mobile mirror of web's `serverBillsApiClient` (apps/web/src/lib/api.server.ts):
// the same auth headers (shared from api.ts), just a different typed client over
// the same api origin. Call sites use `billsApi.api.bills…` alongside the main
// `api.api.…` client.
function buildClient(baseUrl: string) {
  return hc<BillsAppType>(baseUrl, { headers: authHeaders });
}

// Same runtime-URL memoization + Proxy export as api.ts: hc captures the base URL
// at construction, but the server picker can change it, so rebuild on change and
// front it with a stable Proxy.
let client = buildClient(getServerUrl());
let builtFor = getServerUrl();

function liveClient() {
  const url = getServerUrl();
  if (url !== builtFor) {
    client = buildClient(url);
    builtFor = url;
  }
  return client;
}

export const billsApi = new Proxy({} as ReturnType<typeof buildClient>, {
  get: (_target, prop) => liveClient()[prop as keyof ReturnType<typeof buildClient>],
});

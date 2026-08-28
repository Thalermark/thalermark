import type { AppType } from '@thalermark/api-contract';
import { hc } from 'hono/client';
import { publicApiBaseUrl } from './public-api-url.js';

const baseUrl = publicApiBaseUrl;

// On the browser, credentials: include lets the BA session cookie travel with
// every request. On the server (hooks / load), the cookie has to be passed
// explicitly via `headers` since the SvelteKit server has no browser jar.
export function apiClient(extraHeaders?: Record<string, string>) {
  return hc<AppType>(baseUrl, {
    headers: extraHeaders,
    init: { credentials: 'include' },
  });
}

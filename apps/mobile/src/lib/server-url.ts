import { clearStoredServerUrl, getStoredServerUrl, setStoredServerUrl } from './secure-store';

// The API base URL, readable *synchronously*. The hono + Better Auth clients
// capture their base URL at construction, and most call sites build request
// URLs at module load — none can await. So we keep the URL in a module-level
// cache: `getServerUrl()` is sync; `hydrateServerUrl()` (run once at app start,
// before anything renders) pulls the persisted override in; `setServerUrl()`
// updates the cache + persists. The clients in api.ts / auth-client.ts compare
// their built-for URL against `getServerUrl()` and lazily rebuild when it
// changes, so a server switch needs no app restart.
//
// Default is the build-time EXPO_PUBLIC_API_URL — the SaaS cloud in a published
// build. Self-hosters override it in the pre-sign-in picker. (Their server must
// allow `thalermark://` in TRUSTED_ORIGINS; the default self-host compose
// already does.)
const DEFAULT_URL = normalizeUrl(process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000');

let cached = DEFAULT_URL;

export function getServerUrl(): string {
  return cached;
}

export function getDefaultServerUrl(): string {
  return DEFAULT_URL;
}

// Run once at startup before rendering so the clients build against the right
// server. Falls back to the default if nothing is stored or the read fails.
export async function hydrateServerUrl(): Promise<void> {
  try {
    const stored = await getStoredServerUrl();
    if (stored) cached = normalizeUrl(stored);
  } catch {
    // keep the default
  }
}

export async function setServerUrl(url: string): Promise<void> {
  cached = normalizeUrl(url);
  await setStoredServerUrl(cached);
}

export async function resetServerUrl(): Promise<void> {
  cached = DEFAULT_URL;
  await clearStoredServerUrl();
}

// Trim whitespace + trailing slashes so `${url}/api/...` never doubles up.
export function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

// Validate a candidate server before saving it: the API exposes an unauthed,
// CORS-free `GET /health` → { status: 'ok' }. A reachable Thalermark server
// answers; a typo or a non-Thalermark host doesn't.
export async function probeServer(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${normalizeUrl(url)}/health`, { method: 'GET' });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as { status?: string } | null;
    return body?.status === 'ok';
  } catch {
    return false;
  }
}

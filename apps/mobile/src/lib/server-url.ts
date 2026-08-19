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
// What a probe found. Three outcomes, not two, because "the address is wrong"
// and "the address is right and the server is struggling" are different facts
// and the user acts on them differently (TMC-278).
export type ServerProbe =
  | { kind: 'ok' }
  // A Thalermark server answered and told us its database is unreachable. The
  // address is CORRECT: saying "couldn't reach a server" here would send someone
  // off to edit an address that was right all along.
  | { kind: 'degraded' }
  | { kind: 'unreachable' };

// Validate a candidate server before saving it.
//
// Probes GET /ready, which is unauthed and returns { status } plus a database
// check: 200 when it can serve, 503 when the pool is unreachable. Both answers
// prove a Thalermark api is at this address, which is the question being asked.
//
// NOT /health. That is the container's liveness probe and lives at the ROOT of
// the api service, so it is only reachable when the api IS the origin — a bare
// dev server. Under either compose file the proxy sends everything outside
// /api/* to the web app, which has no such route and answers with its sign-in
// page, so the probe read HTML and rejected perfectly good servers (TMC-278).
// /ready is routed explicitly in both Caddyfiles precisely so it can be reached.
export async function probeServer(url: string): Promise<ServerProbe> {
  try {
    const res = await fetch(`${normalizeUrl(url)}/ready`, { method: 'GET' });
    const body = (await res.json().catch(() => null)) as { status?: string } | null;
    // A JSON body carrying `status` is the tell that this is our api and not,
    // say, a proxy's own error page that happens to return 503.
    if (body?.status === 'ok') return { kind: 'ok' };
    if (body?.status === 'error') return { kind: 'degraded' };
    return { kind: 'unreachable' };
  } catch {
    return { kind: 'unreachable' };
  }
}

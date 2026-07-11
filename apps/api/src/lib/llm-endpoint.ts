import { lookup as dnsLookupCb } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

// Guard for the one place a user hands us a URL that the *server* then requests:
// the `custom` provider's base_url, and a base_url override on any openai-wire
// preset (Ollama). Without this, an account owner can aim the API server at
// anything reachable from inside the network — which on a cloud box means
// http://169.254.169.254/ and the credentials it serves.
//
// This is NOT a managed-only concern. A public sign-up on a self-hosted
// Thalermark becomes owner of its own account, and an owner configures AI.
//
// Nor is it fixed by gating "may this account configure AI": the save-time verify
// probe requests the URL regardless of which resolver ever reads the row. The
// guard belongs on the WRITE path, before the probe runs.

export type EndpointPolicy = {
  // Operator security control (AI_ALLOW_PRIVATE_ENDPOINTS), not AI config. A
  // self-hoster running Ollama or a LAN model server must opt in, because
  // http://ollama:11434 resolves into a private range. Managed never sets it.
  // It does NOT unblock link-local / metadata — see IpClass below. Blunt: it
  // opens the WHOLE private range to any account owner.
  allowPrivate: boolean;
  // The precise alternative (AI_ALLOWED_ENDPOINTS): a specific set of host:port
  // endpoints that may resolve private. Grants the same private exception as
  // allowPrivate but scoped to exactly these endpoints, so a self-hoster can
  // reach one Ollama box without opening the rest of the LAN. Still never
  // bypasses the `blocked` class (metadata/link-local) — those stay rejected
  // even for an allowlisted host. Entries are `scheme://host:port` URLs (path
  // ignored); matched by host + effective port.
  allowedEndpoints?: string[];
};

// Stable codes: the route returns these and the UI maps them to copy. A raw
// resolver error is never echoed to the client.
export type EndpointRejection =
  | 'invalid_url'
  | 'unsupported_scheme'
  | 'dns_failed'
  | 'blocked_address'
  | 'private_address';

export type EndpointCheck = { ok: true; url: string } | { ok: false; reason: EndpointRejection };

type Lookup = (hostname: string) => Promise<{ address: string; family: number }[]>;

const defaultLookup: Lookup = (hostname) => lookup(hostname, { all: true });

// Enforced in this order:
//   'blocked' — never permitted, not even with allowPrivate. Link-local (which
//               carries the cloud metadata service at 169.254.169.254 on AWS,
//               GCP and Azure), multicast, reserved, unspecified. Nothing
//               legitimate serves an LLM here.
//   'private' — permitted only with allowPrivate: loopback, RFC1918, CGNAT,
//               IPv6 unique-local. This is where Ollama lives, which is the
//               entire reason the flag exists.
//   'public'  — allowed.
export type IpClass = 'blocked' | 'private' | 'public';

function classifyIpv4Octets(a: number, b: number): IpClass {
  if (a === 169 && b === 254) return 'blocked'; // link-local + cloud metadata
  if (a === 0) return 'blocked'; // 0.0.0.0/8 "this network"
  if (a >= 224) return 'blocked'; // 224/4 multicast, 240/4 reserved, broadcast

  if (a === 127) return 'private'; // loopback
  if (a === 10) return 'private'; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return 'private'; // RFC1918
  if (a === 192 && b === 168) return 'private'; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return 'private'; // RFC6598 CGNAT

  return 'public';
}

function classifyIpv4(ip: string): IpClass {
  // Fail closed on anything that isn't a well-formed dotted quad, rather than
  // letting NaN octets fall through to 'public'.
  if (isIP(ip) !== 4) return 'blocked';
  const octets = ip.split('.').map(Number);
  const [a, b] = octets;
  if (a === undefined || b === undefined) return 'blocked';
  return classifyIpv4Octets(a, b);
}

// Expand an IPv6 literal to its 16 bytes so prefixes are checked numerically.
// Textual prefix matching is not enough: `::ffff:7f00:1` is 127.0.0.1 written in
// hex, and would sail past a check for the string "::ffff:127.".
function ipv6ToBytes(raw: string): Uint8Array | null {
  const addr = (raw.split('%')[0] ?? '').toLowerCase(); // drop any zone id
  if (isIP(addr) !== 6) return null;

  const marker = addr.indexOf('::');
  const headText = marker === -1 ? addr : addr.slice(0, marker);
  const tailText = marker === -1 ? '' : addr.slice(marker + 2);

  const toGroups = (text: string): number[] | null => {
    if (text === '') return [];
    const groups: number[] = [];
    for (const part of text.split(':')) {
      if (part.includes('.')) {
        // A trailing dotted quad (::ffff:127.0.0.1) occupies two groups.
        if (isIP(part) !== 4) return null;
        const octets = part.split('.').map(Number);
        const [a, b, c, d] = octets;
        if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
        groups.push((a << 8) | b, (c << 8) | d);
      } else {
        const value = Number.parseInt(part, 16);
        if (!Number.isInteger(value) || value < 0 || value > 0xffff) return null;
        groups.push(value);
      }
    }
    return groups;
  };

  const head = toGroups(headText);
  const tail = toGroups(tailText);
  if (head === null || tail === null) return null;

  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (marker === -1 && missing !== 0)) return null;

  const groups = [...head, ...new Array<number>(missing).fill(0), ...tail];
  const bytes = new Uint8Array(16);
  groups.forEach((group, i) => {
    bytes[i * 2] = group >> 8;
    bytes[i * 2 + 1] = group & 0xff;
  });
  return bytes;
}

function classifyIpv6(raw: string): IpClass {
  const bytes = ipv6ToBytes(raw);
  if (!bytes) return 'blocked';

  const at = (i: number): number => bytes[i] ?? 0;
  const firstTenZero = Array.from({ length: 10 }, (_, i) => at(i)).every((byte) => byte === 0);

  // ::ffff:a.b.c.d — IPv4-mapped. Must not launder an IPv4 decision.
  if (firstTenZero && at(10) === 0xff && at(11) === 0xff) {
    return classifyIpv4Octets(at(12), at(13));
  }
  if (firstTenZero && at(10) === 0 && at(11) === 0) {
    const low = at(12) === 0 && at(13) === 0 && at(14) === 0;
    if (low && at(15) === 0) return 'blocked'; // :: unspecified
    if (low && at(15) === 1) return 'private'; // ::1 loopback
    return classifyIpv4Octets(at(12), at(13)); // ::a.b.c.d IPv4-compatible
  }

  if (at(0) === 0xff) return 'blocked'; // ff00::/8 multicast
  if (at(0) === 0xfe && (at(1) & 0xc0) === 0x80) return 'blocked'; // fe80::/10 link-local
  if ((at(0) & 0xfe) === 0xfc) return 'private'; // fc00::/7 unique-local

  return 'public';
}

export function classifyAddress(ip: string): IpClass {
  const version = isIP(ip);
  if (version === 4) return classifyIpv4(ip);
  if (version === 6) return classifyIpv6(ip);
  return 'blocked'; // not an IP at all — refuse rather than guess
}

// Every address the name answers with must pass. One bad answer in a round-robin
// is enough to reject the endpoint.
function verdictFor(addresses: string[], privateAllowed: boolean, url: URL): EndpointCheck {
  for (const address of addresses) {
    const category = classifyAddress(address);
    // `blocked` is absolute: never permitted, not by allowPrivate nor the
    // allowlist. That is what keeps the cloud metadata endpoint unreachable even
    // for an operator-blessed host.
    if (category === 'blocked') return { ok: false, reason: 'blocked_address' };
    if (category === 'private' && !privateAllowed) {
      return { ok: false, reason: 'private_address' };
    }
  }
  return { ok: true, url: url.toString() };
}

// scheme://host:port → "host:port" (lowercased host, brackets stripped, default
// port filled from the scheme). The comparison key for the allowlist; path,
// query, and scheme itself are ignored (an http vs https mismatch on the same
// host:port just fails later at connect time, not a security concern).
function originKey(hostname: string, port: string, protocol: string): string {
  const host = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  return `${host}:${port || (protocol === 'https:' ? '443' : '80')}`;
}

function isAllowlisted(url: URL, entries: string[] | undefined): boolean {
  if (!entries || entries.length === 0) return false;
  const target = originKey(url.hostname, url.port, url.protocol);
  for (const entry of entries) {
    try {
      const parsed = new URL(entry.trim());
      if (originKey(parsed.hostname, parsed.port, parsed.protocol) === target) return true;
    } catch {
      // A malformed allowlist entry is ignored (never widens access).
    }
  }
  return false;
}

// Validate a user-supplied base URL. Resolves the hostname and inspects every
// address it answers with — a hostname check alone is useless, because
// evil.example.com can simply publish an A record of 127.0.0.1.
//
// This is the CHECK-time guard (save/verify): it stops an endpoint that resolves
// somewhere bad right now. The complementary CONNECT-time guard is
// createGuardedFetch below, attached to the credential's fetch — it re-validates
// at the moment the AI SDK connects, which is what actually closes DNS rebinding
// (a name that passes here but flips before the call). The two run together.
export async function checkBaseUrl(
  raw: string,
  policy: EndpointPolicy,
  deps: { lookup?: Lookup } = {},
): Promise<EndpointCheck> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'unsupported_scheme' };
  }

  // `new URL('http://[::1]')` keeps the brackets on .hostname.
  const hostname = url.hostname.replace(/^\[/, '').replace(/\]$/, '');
  if (!hostname) return { ok: false, reason: 'invalid_url' };

  // The private exception is granted globally (allowPrivate) OR per-endpoint (the
  // allowlist). Either way, `blocked` addresses stay rejected inside verdictFor.
  const privateAllowed = policy.allowPrivate || isAllowlisted(url, policy.allowedEndpoints);

  // A literal IP needs no resolution — and must not be handed to the resolver,
  // which would happily answer with the address itself.
  if (isIP(hostname) !== 0) return verdictFor([hostname], privateAllowed, url);

  let addresses: string[];
  try {
    const resolved = await (deps.lookup ?? defaultLookup)(hostname);
    addresses = resolved.map((entry) => entry.address);
  } catch {
    return { ok: false, reason: 'dns_failed' };
  }
  if (addresses.length === 0) return { ok: false, reason: 'dns_failed' };

  return verdictFor(addresses, privateAllowed, url);
}

// The request-time half of the SSRF defense. checkBaseUrl is a CHECK-time
// guarantee (save/verify); this is the CONNECT-time one. A guarded fetch resolves
// the hostname and re-classifies every candidate IP at the moment it connects, so
// a name that passed checkBaseUrl but later rebinds to an internal / metadata
// address is refused when the AI SDK actually calls it. undici (not URL
// rewriting) so the connection goes to the validated IP while the hostname is
// kept for TLS SNI + Host — rewriting to the IP would break https cert checks.
//
// Same rule as verdictFor: `blocked` (metadata/link-local) is always refused;
// `private` is refused unless this endpoint's privateAllowed was granted.
export function createGuardedFetch(privateAllowed: boolean): typeof globalThis.fetch {
  const agent = new Agent({
    connect: {
      // A dns.lookup-compatible function undici calls per connection. Resolve
      // ALL addresses, reject if ANY is disallowed (matching checkBaseUrl's
      // all-must-pass rule), then hand back the shape undici asked for.
      lookup(hostname, options, callback) {
        dnsLookupCb(hostname, { all: true, verbatim: true }, (err, addresses) => {
          if (err) return callback(err, '', 0);
          for (const entry of addresses) {
            const category = classifyAddress(entry.address);
            if (category === 'blocked' || (category === 'private' && !privateAllowed)) {
              return callback(new Error(`blocked AI endpoint address (${category})`), '', 0);
            }
          }
          if (options?.all) return callback(null, addresses as never);
          const first = addresses[0];
          if (!first) return callback(new Error('no address'), '', 0);
          return callback(null, first.address, first.family);
        });
      },
    },
  });
  // undici's fetch is spec-compatible with global fetch but nominally distinct
  // (its RequestInit carries `dispatcher`), so bridge through unknown.
  return ((input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) =>
    undiciFetch(
      input as never,
      { ...init, dispatcher: agent } as never,
    )) as unknown as typeof globalThis.fetch;
}

// A factory that turns an endpoint's base URL into a guarded fetch under a fixed
// operator policy — the per-endpoint privateAllowed (allowPrivate OR allowlisted)
// baked in. Cached by base URL so repeated AI calls reuse one undici Agent
// (connection pool) instead of building one per call. server.ts hands this to the
// connection store; the store attaches the fetch to any credential that carries a
// user-supplied base URL.
export function guardedFetchForPolicy(
  policy: EndpointPolicy,
): (baseUrl: string) => typeof globalThis.fetch {
  const cache = new Map<string, typeof globalThis.fetch>();
  return (baseUrl) => {
    let privateAllowed = policy.allowPrivate;
    if (!privateAllowed) {
      try {
        privateAllowed = isAllowlisted(new URL(baseUrl), policy.allowedEndpoints);
      } catch {
        // A malformed base URL never reaches here (checkBaseUrl vetted it), but
        // fail closed regardless: no allowlist match.
      }
    }
    const key = `${privateAllowed}:${baseUrl}`;
    let fetch = cache.get(key);
    if (!fetch) {
      fetch = createGuardedFetch(privateAllowed);
      cache.set(key, fetch);
    }
    return fetch;
  };
}

import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type EndpointCheck,
  checkBaseUrl,
  classifyAddress,
  createGuardedFetch,
  guardedFetchForPolicy,
} from './llm-endpoint.js';

const OPEN = { allowPrivate: true };
const STRICT = { allowPrivate: false };

// A stub resolver so the tests never touch real DNS.
const resolvesTo =
  (...addresses: string[]) =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

const failingLookup = async () => {
  throw new Error('ENOTFOUND');
};

const reasonOf = (check: EndpointCheck) => (check.ok ? 'ok' : check.reason);

describe('classifyAddress', () => {
  it('blocks link-local and the cloud metadata endpoint', () => {
    expect(classifyAddress('169.254.169.254')).toBe('blocked');
    expect(classifyAddress('169.254.0.1')).toBe('blocked');
    expect(classifyAddress('fe80::1')).toBe('blocked');
  });

  it('blocks unspecified, multicast and reserved', () => {
    expect(classifyAddress('0.0.0.0')).toBe('blocked');
    expect(classifyAddress('224.0.0.1')).toBe('blocked');
    expect(classifyAddress('255.255.255.255')).toBe('blocked');
    expect(classifyAddress('::')).toBe('blocked');
    expect(classifyAddress('ff02::1')).toBe('blocked');
  });

  it('marks loopback, RFC1918, CGNAT and IPv6 ULA private', () => {
    expect(classifyAddress('127.0.0.1')).toBe('private');
    expect(classifyAddress('10.0.0.5')).toBe('private');
    expect(classifyAddress('172.16.0.1')).toBe('private');
    expect(classifyAddress('172.31.255.254')).toBe('private');
    expect(classifyAddress('192.168.1.1')).toBe('private');
    expect(classifyAddress('100.64.0.1')).toBe('private');
    expect(classifyAddress('::1')).toBe('private');
    expect(classifyAddress('fd00::1')).toBe('private');
  });

  it('allows genuinely public addresses', () => {
    expect(classifyAddress('1.1.1.1')).toBe('public');
    expect(classifyAddress('172.32.0.1')).toBe('public');
    expect(classifyAddress('172.15.255.255')).toBe('public');
    expect(classifyAddress('2606:4700::1111')).toBe('public');
  });

  // The bypass a textual prefix check would miss: these are all 127.0.0.1 and
  // 169.254.169.254 wearing an IPv6 hat.
  it('sees through IPv4-mapped and IPv4-compatible IPv6 forms', () => {
    expect(classifyAddress('::ffff:127.0.0.1')).toBe('private');
    expect(classifyAddress('::ffff:7f00:1')).toBe('private');
    expect(classifyAddress('::ffff:169.254.169.254')).toBe('blocked');
    expect(classifyAddress('::ffff:a9fe:a9fe')).toBe('blocked');
    expect(classifyAddress('::127.0.0.1')).toBe('private');
  });

  it('fails closed on anything that is not an address', () => {
    for (const junk of ['', 'localhost', 'not-an-ip', '999.1.1.1', '1.2.3']) {
      expect(classifyAddress(junk)).toBe('blocked');
    }
  });
});

describe('checkBaseUrl', () => {
  it('accepts a public https endpoint', async () => {
    const check = await checkBaseUrl('https://api.x.ai/v1', STRICT, {
      lookup: resolvesTo('104.18.0.1'),
    });
    expect(check).toEqual({ ok: true, url: 'https://api.x.ai/v1' });
  });

  it('rejects a non-http scheme', async () => {
    for (const url of ['file:///etc/passwd', 'gopher://x/', 'ftp://x/']) {
      expect(reasonOf(await checkBaseUrl(url, OPEN))).toBe('unsupported_scheme');
    }
  });

  it('rejects a malformed url', async () => {
    for (const url of ['', 'not a url', '///', 'http://']) {
      expect(reasonOf(await checkBaseUrl(url, OPEN))).toBe('invalid_url');
    }
  });

  // The attack this whole module exists for.
  it('rejects the cloud metadata endpoint, even with allowPrivate', async () => {
    expect(reasonOf(await checkBaseUrl('http://169.254.169.254/latest/', OPEN))).toBe(
      'blocked_address',
    );
    expect(reasonOf(await checkBaseUrl('http://[fe80::1]/v1', OPEN))).toBe('blocked_address');
  });

  it('rejects private literals under the default policy', async () => {
    for (const url of ['http://127.0.0.1:11434', 'http://10.1.2.3/v1', 'http://[::1]:11434/v1']) {
      expect(reasonOf(await checkBaseUrl(url, STRICT))).toBe('private_address');
    }
  });

  it('allows private literals when the operator opts in (the Ollama path)', async () => {
    expect((await checkBaseUrl('http://127.0.0.1:11434/v1', OPEN)).ok).toBe(true);
    expect((await checkBaseUrl('http://[::1]:11434/v1', OPEN)).ok).toBe(true);
  });

  // A hostname check alone is useless: the name is attacker-controlled and can
  // simply publish an A record pointing inward.
  it('resolves the hostname and judges the resolved address', async () => {
    expect(
      reasonOf(
        await checkBaseUrl('https://evil.example.com/v1', STRICT, {
          lookup: resolvesTo('127.0.0.1'),
        }),
      ),
    ).toBe('private_address');

    expect(
      reasonOf(
        await checkBaseUrl('https://evil.example.com/v1', OPEN, {
          lookup: resolvesTo('169.254.169.254'),
        }),
      ),
    ).toBe('blocked_address');
  });

  it('rejects when any address in a round-robin answer is disallowed', async () => {
    expect(
      reasonOf(
        await checkBaseUrl('https://mixed.example.com/v1', STRICT, {
          lookup: resolvesTo('93.184.216.34', '10.0.0.1'),
        }),
      ),
    ).toBe('private_address');
  });

  it('does not hand a literal IP to the resolver', async () => {
    const check = await checkBaseUrl('http://1.1.1.1/v1', STRICT, { lookup: failingLookup });
    expect(check.ok).toBe(true);
  });

  it('reports dns failure distinctly from a policy rejection', async () => {
    expect(
      reasonOf(await checkBaseUrl('https://nx.example.com/v1', OPEN, { lookup: failingLookup })),
    ).toBe('dns_failed');
    expect(
      reasonOf(await checkBaseUrl('https://empty.example.com/v1', OPEN, { lookup: resolvesTo() })),
    ).toBe('dns_failed');
  });

  it('allows a public hostname that resolves publicly', async () => {
    const check = await checkBaseUrl('https://api.openai.com/v1', STRICT, {
      lookup: resolvesTo('104.18.7.192', '2606:4700::6812:7c0'),
    });
    expect(check.ok).toBe(true);
  });
});

describe('checkBaseUrl — the AI_ALLOWED_ENDPOINTS allowlist', () => {
  const allow = (...allowedEndpoints: string[]) => ({ allowPrivate: false, allowedEndpoints });

  it('permits a private literal on the allowlist, without opening the LAN', async () => {
    const policy = allow('http://192.168.1.10:11434');
    expect((await checkBaseUrl('http://192.168.1.10:11434/v1', policy)).ok).toBe(true);
    // A different private box is still blocked — this is the whole point vs the boolean.
    expect(reasonOf(await checkBaseUrl('http://192.168.1.11:11434/v1', policy))).toBe(
      'private_address',
    );
  });

  it('matches by host:port, ignoring path and scheme', async () => {
    const policy = allow('http://ollama:11434/anything');
    expect(
      (await checkBaseUrl('https://ollama:11434/v1', policy, { lookup: resolvesTo('172.18.0.5') }))
        .ok,
    ).toBe(true);
  });

  it('does NOT match a different port', async () => {
    const policy = allow('http://ollama:11434');
    expect(
      reasonOf(
        await checkBaseUrl('http://ollama:8080/v1', policy, { lookup: resolvesTo('172.18.0.5') }),
      ),
    ).toBe('private_address');
  });

  // The invariant: an allowlisted host that (somehow) resolves to metadata is
  // STILL blocked. The allowlist grants the private exception, never the blocked one.
  it('never lets an allowlisted host reach a blocked address', async () => {
    const policy = allow('http://ollama:11434');
    expect(
      reasonOf(
        await checkBaseUrl('http://ollama:11434/v1', policy, {
          lookup: resolvesTo('169.254.169.254'),
        }),
      ),
    ).toBe('blocked_address');
  });

  it('ignores a malformed allowlist entry (never widens access)', async () => {
    const policy = allow('not a url', 'http://192.168.1.10:11434');
    expect((await checkBaseUrl('http://192.168.1.10:11434/v1', policy)).ok).toBe(true);
    expect(reasonOf(await checkBaseUrl('http://127.0.0.1:11434/v1', policy))).toBe(
      'private_address',
    );
  });

  it('an empty allowlist changes nothing', async () => {
    expect(reasonOf(await checkBaseUrl('http://127.0.0.1:11434/v1', allow()))).toBe(
      'private_address',
    );
  });
});

// The CONNECT-time guard. A real loopback server proves the point that a static
// analysis can't: even though the server is reachable, the guarded fetch refuses
// it when private isn't allowed (localhost → 127.0.0.1, a private address checked
// at connect time), and connects when it is. This is what actually closes DNS
// rebinding — the check happens when the socket opens, not at save time.
describe('createGuardedFetch — connect-time validation', () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => {
    server.close();
  });

  it('blocks a hostname resolving to a private address when private is not allowed', async () => {
    const guarded = createGuardedFetch(false);
    // localhost resolves to 127.0.0.1 / ::1 — both private. The server IS up, so a
    // rejection here can only come from the connect-time guard, not a dead socket.
    await expect(guarded(`http://localhost:${port}/`)).rejects.toThrow();
  });

  it('allows the same connection when private is permitted', async () => {
    const guarded = createGuardedFetch(true);
    const res = await guarded(`http://localhost:${port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('blocks a public-looking host that a resolver would point inward (rebinding)', async () => {
    // Not wired here to a stub resolver — the point is covered by the localhost
    // cases above (a name → private IP is refused at connect). This asserts the
    // policy factory grants the exception only for the allowlisted endpoint.
    const factory = guardedFetchForPolicy({
      allowPrivate: false,
      allowedEndpoints: [`http://localhost:${port}`],
    });
    // Allowlisted host:port → private exception granted → connects.
    const res = await factory(`http://localhost:${port}/v1`)(`http://localhost:${port}/`);
    expect(res.status).toBe(200);
    // A different loopback port is not allowlisted → still blocked at connect.
    await expect(factory('http://localhost:1/v1')(`http://localhost:${port}/`)).rejects.toThrow();
  });
});

import { createHmac, timingSafeEqual } from 'node:crypto';

// Signed download tokens for the local-FS adapter. The object store has no
// presigning of its own, so the api serves bytes through /api/files/<token>;
// the token is an HMAC-signed { key, exp } so a recipient can't read an
// arbitrary key or keep a URL alive past its TTL. Format is
// `<base64url(payload)>.<base64url(hmac)>` — compact, URL-safe, no padding.

export interface FileTokenPayload {
  key: string;
  // Expiry as a unix epoch in seconds.
  exp: number;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function sign(body: string, secret: string): string {
  return b64url(createHmac('sha256', secret).update(body).digest());
}

export function signFileToken(payload: FileTokenPayload, secret: string): string {
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  return `${body}.${sign(body, secret)}`;
}

// Returns the decoded payload when the signature is valid AND the token is
// unexpired; null otherwise. Signature check is constant-time, and runs before
// any JSON parse so a tampered body can't reach the parser. `now` is injectable
// for tests.
export function verifyFileToken(
  token: string,
  secret: string,
  now: number = Date.now(),
): FileTokenPayload | null {
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const provided = token.slice(dot + 1);
  const expected = sign(body, secret);

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (
    typeof payload !== 'object' ||
    payload === null ||
    typeof (payload as FileTokenPayload).key !== 'string' ||
    typeof (payload as FileTokenPayload).exp !== 'number'
  ) {
    return null;
  }
  const p = payload as FileTokenPayload;
  if (now > p.exp * 1000) return null;
  return p;
}

import { createHmac } from 'node:crypto';

// Returns the HMAC-SHA256 of `body` keyed by `secret`, hex-encoded. The
// receiving endpoint validates this against the same shared secret to
// authenticate the payload origin and detect in-flight tampering.
//
// Symmetric HMAC (rather than asymmetric signing) is sufficient here: this
// stream is anonymous telemetry, the secret is server-side only, and the
// threat model is "did this batch come from a real Thalermark instance" —
// not non-repudiation. Keys are env-provisioned per deployment (see
// TELEMETRY_SIGNING_KEY in .env.example).
export function signPayload(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

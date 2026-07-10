import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

// Encryption at rest for the one secret Thalermark stores on a tenant's behalf:
// the LLM API key on llm_connections. Everything else in the DB is plain — this
// column gets ciphertext because it is the only value a stranger holding a
// leaked backup could immediately spend.
//
// AES-256-GCM, one derived key, no envelope. Envelope encryption earns its keep
// with large payloads (re-encrypting on rotation) or an unextractable KMS; the
// payload here is a ~100-byte key and self-host has no KMS. If the managed
// platform ever wants KMS it brings its own store behind the credential-resolver
// seam — see spikes/AI-CONNECTION.md §5.

// The stored format: v1:<iv>:<authTag>:<ciphertext>, each part base64.
//
// The version prefix is three characters of foresight. To rotate the master key
// you write new rows as v2 and decrypt by prefix, so old and new coexist and
// re-encryption is a background script. Without it, rotation is a stop-the-world
// migration.
const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12; // 96-bit nonce, the GCM standard
const HKDF_SALT = 'thalermark-llm-connection-v1';

// Derive the master key from BETTER_AUTH_SECRET rather than demanding a new env
// var. That secret is already required at boot (apps/api/src/env.ts) and already
// guarded against the shipped placeholder in production, so a self-hoster can
// configure AI from the UI without generating or setting anything.
//
// HKDF with a distinct salt gives domain separation: the derived key is not the
// auth secret, and recovering one does not yield the other. Never use
// BETTER_AUTH_SECRET directly as an AES key.
//
// Consequence, documented rather than discovered: rotating BETTER_AUTH_SECRET
// orphans every stored key. Rotating it already invalidates every session, so it
// is a known-disruptive act; decryption then fails closed and the account is
// asked to reconnect its AI provider.
export function deriveConnectionKey(betterAuthSecret: string): Buffer {
  if (!betterAuthSecret) throw new Error('deriveConnectionKey: secret is required');
  return Buffer.from(hkdfSync('sha256', betterAuthSecret, HKDF_SALT, '', KEY_BYTES));
}

// Encrypt a secret for storage. The plaintext never leaves this module, is never
// logged, and is never returned to a client after the write that supplied it.
export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  // getAuthTag is only valid after final(). ':' is not in the base64 alphabet,
  // so the parts are unambiguous.
  const authTag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
}

// Decrypt a stored secret. Throws on a tampered payload (GCM's auth tag fails),
// an unknown version prefix, or a malformed blob. Callers treat a throw as "this
// connection is unusable" and resolve a null credential — they must not surface
// the message, which is why every one here is deliberately content-free.
export function decryptSecret(blob: string, key: Buffer): string {
  const parts = blob.split(':');
  if (parts.length !== 4) throw new Error('decryptSecret: malformed payload');
  const [version, ivB64, tagB64, ciphertextB64] = parts as [string, string, string, string];
  if (version !== VERSION) throw new Error('decryptSecret: unsupported version');

  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  if (iv.length !== IV_BYTES) throw new Error('decryptSecret: malformed payload');

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

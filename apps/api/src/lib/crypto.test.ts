import { describe, expect, it } from 'vitest';
import { decryptSecret, deriveConnectionKey, encryptSecret } from './crypto.js';

const SECRET = 'a-genuinely-random-better-auth-secret-value';
const key = deriveConnectionKey(SECRET);
const API_KEY = 'sk-ant-api03-abcdef0123456789';

describe('deriveConnectionKey', () => {
  it('produces a 32-byte key, deterministically', () => {
    expect(key).toHaveLength(32);
    expect(deriveConnectionKey(SECRET).equals(key)).toBe(true);
  });

  it('is not the auth secret itself (HKDF domain separation)', () => {
    expect(key.toString('utf8')).not.toContain(SECRET);
    expect(key.toString('base64')).not.toBe(Buffer.from(SECRET).toString('base64'));
  });

  it('a different secret yields a different key', () => {
    expect(deriveConnectionKey(`${SECRET}x`).equals(key)).toBe(false);
  });

  it('refuses an empty secret', () => {
    expect(() => deriveConnectionKey('')).toThrow(/required/);
  });
});

describe('encryptSecret / decryptSecret', () => {
  it('round-trips', () => {
    expect(decryptSecret(encryptSecret(API_KEY, key), key)).toBe(API_KEY);
  });

  it('round-trips unicode and the empty string', () => {
    for (const value of ['', 'ollama', '🔑-ключ-鍵']) {
      expect(decryptSecret(encryptSecret(value, key), key)).toBe(value);
    }
  });

  it('stamps the v1 prefix and four base64 parts', () => {
    const blob = encryptSecret(API_KEY, key);
    const parts = blob.split(':');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('v1');
    // A 96-bit iv and a 128-bit GCM tag.
    expect(Buffer.from(parts[1] ?? '', 'base64')).toHaveLength(12);
    expect(Buffer.from(parts[2] ?? '', 'base64')).toHaveLength(16);
  });

  it('never emits the plaintext', () => {
    expect(encryptSecret(API_KEY, key)).not.toContain(API_KEY);
  });

  it('uses a fresh iv per call, so the same plaintext never repeats a ciphertext', () => {
    const blobs = new Set(Array.from({ length: 25 }, () => encryptSecret(API_KEY, key)));
    expect(blobs.size).toBe(25);
  });

  it('fails closed on the wrong key', () => {
    const blob = encryptSecret(API_KEY, key);
    expect(() => decryptSecret(blob, deriveConnectionKey('some-other-secret'))).toThrow();
  });

  // GCM's auth tag is the point: a mutated ciphertext must not decrypt to
  // garbage, it must refuse.
  it('fails closed on a tampered ciphertext', () => {
    const [version, iv, tag, ciphertext] = encryptSecret(API_KEY, key).split(':') as [
      string,
      string,
      string,
      string,
    ];
    const flipped = Buffer.from(ciphertext, 'base64');
    const first = flipped[0];
    if (first === undefined) throw new Error('unreachable: ciphertext is non-empty');
    flipped[0] = first ^ 0x01;
    const blob = [version, iv, tag, flipped.toString('base64')].join(':');
    expect(() => decryptSecret(blob, key)).toThrow();
  });

  it('fails closed on a tampered auth tag', () => {
    const [version, iv, _tag, ciphertext] = encryptSecret(API_KEY, key).split(':') as [
      string,
      string,
      string,
      string,
    ];
    const forged = Buffer.alloc(16).toString('base64');
    expect(() => decryptSecret([version, iv, forged, ciphertext].join(':'), key)).toThrow();
  });

  it('rejects an unknown version prefix rather than guessing', () => {
    const blob = encryptSecret(API_KEY, key).replace(/^v1:/, 'v2:');
    expect(() => decryptSecret(blob, key)).toThrow(/unsupported version/);
  });

  it('rejects a malformed payload', () => {
    for (const blob of ['', 'v1', 'v1:a:b', 'v1:a:b:c:d', 'not-a-blob']) {
      expect(() => decryptSecret(blob, key)).toThrow();
    }
  });

  it('rejects a payload whose iv is the wrong length', () => {
    const [, , tag, ciphertext] = encryptSecret(API_KEY, key).split(':') as [
      string,
      string,
      string,
      string,
    ];
    const shortIv = Buffer.alloc(8).toString('base64');
    expect(() => decryptSecret(['v1', shortIv, tag, ciphertext].join(':'), key)).toThrow(
      /malformed/,
    );
  });

  // The error text reaches an admin's screen; it must never carry the secret.
  it('error messages carry no plaintext', () => {
    const blob = encryptSecret(API_KEY, key);
    try {
      decryptSecret(blob, deriveConnectionKey('wrong'));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(String(error)).not.toContain(API_KEY);
    }
  });
});

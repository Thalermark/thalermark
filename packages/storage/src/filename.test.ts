import { describe, expect, it } from 'vitest';
import { assertSafeDownloadFilename } from './filename.js';

// This string becomes a content-disposition header. The guard exists so that a
// caller bug cannot turn an expense's merchant name into header injection, so
// the interesting cases are all the ways a name could break out of the header
// rather than the happy path.
describe('assertSafeDownloadFilename', () => {
  it('accepts the slugged names the receipt route produces', () => {
    for (const ok of [
      'receipt-shell-2026-04-02.jpg',
      'receipt-2026-04-02.pdf',
      'receipt.png',
      'a',
      'receipt_1-2.jpeg',
    ]) {
      expect(() => assertSafeDownloadFilename(ok)).not.toThrow();
    }
  });

  it('rejects anything that could break out of the header', () => {
    for (const bad of [
      'receipt".jpg', // closes the quoted filename
      'receipt\r\nX-Evil: 1', // CRLF injection, the reason this exists
      'receipt\n.jpg',
      'receipt;.jpg',
      'receipt .jpg', // a space needs quoting rules we do not want to reason about
      'Receipt.jpg', // uppercase is not produced by the slug, so it signals a bug
      'reçu.jpg',
    ]) {
      expect(() => assertSafeDownloadFilename(bad)).toThrow(/unsafe download filename/);
    }
  });

  it('rejects path traversal and anything not starting alphanumeric', () => {
    for (const bad of ['../secret.jpg', 'a/../b.jpg', '/etc/passwd', '-receipt.jpg', '.hidden']) {
      expect(() => assertSafeDownloadFilename(bad)).toThrow(/unsafe download filename/);
    }
  });

  it('rejects an empty name and an over-long one', () => {
    expect(() => assertSafeDownloadFilename('')).toThrow();
    expect(() => assertSafeDownloadFilename(`a${'b'.repeat(100)}.jpg`)).toThrow();
  });
});

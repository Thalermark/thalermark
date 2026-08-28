import { assertSafeDownloadFilename } from '@thalermark/storage';
import { describe, expect, it } from 'vitest';
import { receiptFilename } from './route-helpers.js';

// The name a downloaded receipt lands as (TMC-267). Two jobs: be recognisable in
// a folder, and never produce something the storage guard would reject — the
// guard is the safety net, this is what stops it ever firing.
describe('receiptFilename', () => {
  it('reads as the expense the user remembers', () => {
    expect(receiptFilename('Shell', '2026-04-02', 'accounts/a/x/abc.jpg')).toBe(
      'receipt-shell-2026-04-02.jpg',
    );
  });

  it('slugs punctuation and spaces out of a real merchant name', () => {
    expect(receiptFilename("Ray's Lawn & Garden", '2026-04-02', 'a/b.png')).toBe(
      'receipt-rays-lawn-garden-2026-04-02.png',
    );
  });

  it('drops a merchant with no usable characters instead of leading with a dash', () => {
    // A leading dash would fail the storage guard, so this case matters.
    expect(receiptFilename('日本語', '2026-04-02', 'a/b.pdf')).toBe('receipt-2026-04-02.pdf');
    expect(receiptFilename('', '2026-04-02', 'a/b.pdf')).toBe('receipt-2026-04-02.pdf');
    expect(receiptFilename('!!!', '2026-04-02', 'a/b.pdf')).toBe('receipt-2026-04-02.pdf');
  });

  it('omits a date it does not recognise rather than pasting it in', () => {
    expect(receiptFilename('Shell', 'not-a-date', 'a/b.jpg')).toBe('receipt-shell.jpg');
  });

  it('drops an extension that is missing or implausible', () => {
    expect(receiptFilename('Shell', '2026-04-02', 'a/b')).toBe('receipt-shell-2026-04-02');
    expect(receiptFilename('Shell', '2026-04-02', 'a/b.verylongext')).toBe(
      'receipt-shell-2026-04-02',
    );
  });

  it('truncates a very long merchant without leaving a trailing dash', () => {
    const name = receiptFilename(`${'a'.repeat(38)} bcdefg`, '2026-04-02', 'a/b.jpg');
    expect(name.endsWith('-.jpg')).toBe(false);
    expect(() => assertSafeDownloadFilename(name)).not.toThrow();
  });

  // The property that actually matters: whatever a user types as a merchant, the
  // result is always something safe to put in a content-disposition header.
  it('never produces a name the storage guard rejects', () => {
    for (const merchant of [
      'Shell',
      'Ray\'s "Lawn" & Garden',
      'a\r\nX-Evil: 1',
      '../../etc/passwd',
      '   ',
      '🧾 receipts',
      'A'.repeat(200),
    ]) {
      const name = receiptFilename(merchant, '2026-04-02', 'a/b.jpg');
      expect(() => assertSafeDownloadFilename(name)).not.toThrow();
    }
  });
});

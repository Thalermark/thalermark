import { describe, expect, it } from 'vitest';
import { formatSender } from './sender.js';

describe('formatSender', () => {
  it('swaps the display name onto the base address', () => {
    expect(formatSender('Thalermark <hello@thalermark.com>', 'Always Sunny Lawncare')).toBe(
      '"Always Sunny Lawncare" <hello@thalermark.com>',
    );
  });

  it('works when the base is a bare address', () => {
    expect(formatSender('hello@thalermark.com', 'Always Sunny Lawncare')).toBe(
      '"Always Sunny Lawncare" <hello@thalermark.com>',
    );
  });

  it('quotes a name containing a comma', () => {
    expect(formatSender('Thalermark <hello@thalermark.com>', 'Sunny, LLC')).toBe(
      '"Sunny, LLC" <hello@thalermark.com>',
    );
  });

  it('strips CR/LF to block header injection', () => {
    const out = formatSender(
      'Thalermark <hello@thalermark.com>',
      'Evil\r\nBcc: victim@example.com',
    );
    expect(out).not.toMatch(/[\r\n]/);
    expect(out).toBe('"Evil Bcc: victim@example.com" <hello@thalermark.com>');
  });

  it('escapes embedded quotes and backslashes', () => {
    expect(formatSender('Thalermark <hello@thalermark.com>', 'Bob "the" \\Builder')).toBe(
      '"Bob \\"the\\" \\\\Builder" <hello@thalermark.com>',
    );
  });

  it('falls back to the base from when the name is empty after sanitising', () => {
    expect(formatSender('Thalermark <hello@thalermark.com>', '   ')).toBe(
      'Thalermark <hello@thalermark.com>',
    );
  });
});

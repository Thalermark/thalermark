import { describe, expect, it } from 'vitest';
import { formatSender, resolveReplyTo } from './sender.js';

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

describe('resolveReplyTo', () => {
  const FROM = 'Thalermark <hello@thalermark.com>';

  it('prefers the deliberate setting', () => {
    expect(
      resolveReplyTo(
        { replyToEmail: 'ask@ridgeline.com', businessEmail: 'hi@ridgeline.com' },
        FROM,
      ),
    ).toBe('ask@ridgeline.com');
  });

  // The case TMC-225 is really about: nobody sets reply-to, but the wizard
  // collected a business email, so replies reach the business anyway.
  it('falls back to the business email', () => {
    expect(resolveReplyTo({ replyToEmail: null, businessEmail: 'hi@ridgeline.com' }, FROM)).toBe(
      'hi@ridgeline.com',
    );
  });

  it('treats a blank setting as unset', () => {
    expect(resolveReplyTo({ replyToEmail: '   ', businessEmail: 'hi@ridgeline.com' }, FROM)).toBe(
      'hi@ridgeline.com',
    );
  });

  it('lands on no-reply only when the business has given no address at all', () => {
    expect(resolveReplyTo({ replyToEmail: null, businessEmail: null }, FROM)).toBe(
      'no-reply@thalermark.com',
    );
  });

  // The self-host guard. A no-reply hardcoded to thalermark.com would aim a
  // greenacres.com customer's reply at a domain its operator does not own.
  it('derives the no-reply domain from the configured From', () => {
    expect(
      resolveReplyTo(
        { replyToEmail: null, businessEmail: null },
        'Green Acres <billing@greenacres.com>',
      ),
    ).toBe('no-reply@greenacres.com');
    expect(
      resolveReplyTo({ replyToEmail: null, businessEmail: null }, 'billing@greenacres.com'),
    ).toBe('no-reply@greenacres.com');
  });

  // Never invent an address off a malformed From — omitting the header is the
  // old behaviour and is the safer failure.
  it('returns empty when the From has no parseable domain', () => {
    expect(resolveReplyTo({ replyToEmail: null, businessEmail: null }, 'not-an-address')).toBe('');
  });
});

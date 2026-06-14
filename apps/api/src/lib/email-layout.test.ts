import { describe, expect, it } from 'vitest';
import { emailFooterText, renderEmailHtml } from './email-layout.js';

describe('renderEmailHtml', () => {
  const base = {
    brandName: 'Sunny Lawncare',
    preheader: 'Invoice INV-001 is ready',
    heading: 'Invoice INV-001',
    bodyHtml: '<p>Hi there,</p>',
  };

  it('renders a full HTML document with the wordmark and body', () => {
    const html = renderEmailHtml(base);
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('Sunny Lawncare');
    expect(html).toContain('<p>Hi there,</p>');
    // Heading is present and gains the gold-period flourish.
    expect(html).toContain('Invoice INV-001');
  });

  it('renders the CTA as a real link to the given url', () => {
    const html = renderEmailHtml({
      ...base,
      cta: { label: 'View invoice', url: 'https://app.test/i/abc123' },
    });
    expect(html).toContain('href="https://app.test/i/abc123"');
    expect(html).toContain('View invoice');
  });

  it('escapes interpolated scalar fields', () => {
    const html = renderEmailHtml({
      ...base,
      brandName: 'A & B <Co>',
      cta: { label: 'Go', url: 'https://x.test/?a=1&b=2' },
    });
    expect(html).toContain('A &amp; B &lt;Co&gt;');
    expect(html).toContain('href="https://x.test/?a=1&amp;b=2"');
    // bodyHtml is the trusted seam — passed through unescaped.
    expect(html).toContain('<p>Hi there,</p>');
  });

  it('toggles the footer line on poweredBy', () => {
    expect(renderEmailHtml({ ...base, poweredBy: true })).toContain('Sent with Thalermark');
    expect(renderEmailHtml({ ...base, poweredBy: false })).not.toContain('Sent with Thalermark');
    expect(emailFooterText(true)).toBe('Sent with Thalermark · thalermark.com');
    expect(emailFooterText(false)).toBe('Thalermark · thalermark.com');
  });

  it('includes the preheader and omits an absent CTA/footnote', () => {
    const html = renderEmailHtml(base);
    expect(html).toContain('Invoice INV-001 is ready');
    expect(html).not.toContain('border-radius:4px;background:#0f1626');
  });
});

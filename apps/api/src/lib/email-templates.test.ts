import { describe, expect, it } from 'vitest';
import { DEFAULT_TEMPLATES, applyTemplate, renderTemplate } from './email-templates.js';

describe('applyTemplate', () => {
  it('substitutes known tokens, tolerating inner whitespace', () => {
    expect(
      applyTemplate('Hi {{customer_name}} / {{ amount }}', {
        customer_name: 'Dana',
        amount: '$10',
      }),
    ).toBe('Hi Dana / $10');
  });

  it('leaves unknown tokens literal', () => {
    expect(applyTemplate('Hi {{nope}}', { customer_name: 'Dana' })).toBe('Hi {{nope}}');
  });
});

describe('renderTemplate', () => {
  const values = {
    customer_name: 'Dana',
    invoice_number: 'INV-1',
    amount: '100.00 USD',
    due_date: '2026-07-01',
    company_name: 'Sunny',
  };

  it('strips newlines from the subject (header-injection guard)', () => {
    const { subject } = renderTemplate(
      { subject: 'Invoice {{invoice_number}}\nBcc: evil@x', body: 'x' },
      values,
    );
    expect(subject).toBe('Invoice INV-1 Bcc: evil@x');
    expect(subject).not.toContain('\n');
  });

  it('produces a plain-text body with raw values', () => {
    const { textBody } = renderTemplate(DEFAULT_TEMPLATES.invoice, values);
    expect(textBody).toContain('Hi Dana,');
    expect(textBody).toContain('Invoice INV-1 for 100.00 USD');
    expect(textBody).not.toContain('<p>');
  });

  it('paragraphizes the html body and escapes user text + values', () => {
    const { htmlBody } = renderTemplate(
      { subject: 's', body: 'Hi {{customer_name}},\n\nThanks <always> & forever.' },
      { customer_name: 'A & B <script>' },
    );
    // Two paragraphs, first margin:0.
    expect(htmlBody).toContain('<p style="margin:0;">Hi A &amp; B &lt;script&gt;,</p>');
    expect(htmlBody).toContain(
      '<p style="margin:14px 0 0;">Thanks &lt;always&gt; &amp; forever.</p>',
    );
    // No raw angle brackets from user content leaked through.
    expect(htmlBody).not.toContain('<script>');
    expect(htmlBody).not.toContain('<always>');
  });

  it('converts single newlines within a paragraph to <br>', () => {
    const { htmlBody } = renderTemplate({ subject: 's', body: 'line one\nline two' }, {});
    expect(htmlBody).toBe('<p style="margin:0;">line one<br>line two</p>');
  });
});

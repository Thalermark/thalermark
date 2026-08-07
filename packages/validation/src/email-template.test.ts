import { describe, expect, it } from 'vitest';
import {
  EMAIL_TEMPLATE_PLACEHOLDERS,
  EMAIL_TEMPLATE_TYPES,
  emailTemplateUpdateSchema,
  extractPlaceholders,
  unknownPlaceholders,
} from './email-template.js';

describe('email-template validation', () => {
  it('covers the four customer-facing types, each with a placeholder set', () => {
    expect(EMAIL_TEMPLATE_TYPES).toEqual(['invoice', 'estimate', 'statement', 'reminder']);
    for (const t of EMAIL_TEMPLATE_TYPES) {
      expect(EMAIL_TEMPLATE_PLACEHOLDERS[t].length).toBeGreaterThan(0);
      expect(EMAIL_TEMPLATE_PLACEHOLDERS[t]).toContain('company_name');
    }
  });

  it('a reminder can say what is OUTSTANDING and cannot say the total', () => {
    // Enforced by absence rather than documentation (TMC-189). A reminder
    // chases what is still owed, and the two stop being the same number the
    // moment a deposit exists — so {{amount}} is simply not offered, and
    // unknownPlaceholders rejects it at save time.
    expect(EMAIL_TEMPLATE_PLACEHOLDERS.reminder).toContain('outstanding');
    expect(EMAIL_TEMPLATE_PLACEHOLDERS.reminder).not.toContain('amount');
    expect(unknownPlaceholders('reminder', 'You owe {{amount}}')).toEqual(['amount']);
    expect(unknownPlaceholders('reminder', 'You owe {{outstanding}}')).toEqual([]);
  });

  it('extracts placeholders, tolerating inner whitespace + duplicates', () => {
    expect(extractPlaceholders('Hi {{customer_name}}, invoice {{ invoice_number }}')).toEqual([
      'customer_name',
      'invoice_number',
    ]);
    expect(extractPlaceholders('{{amount}} then {{amount}}')).toEqual(['amount', 'amount']);
    expect(extractPlaceholders('no tokens here')).toEqual([]);
  });

  it('flags only placeholders not allowed for the type', () => {
    expect(
      unknownPlaceholders('invoice', 'Invoice {{invoice_number}}', 'Hi {{customer_name}}'),
    ).toEqual([]);
    // estimate_number is valid on estimates but not invoices; bogus is never valid.
    expect(unknownPlaceholders('invoice', '{{estimate_number}} {{bogus}} {{bogus}}')).toEqual([
      'estimate_number',
      'bogus',
    ]);
  });

  it('rejects empty + over-long fields, accepts a valid template', () => {
    expect(emailTemplateUpdateSchema.safeParse({ subject: '', body: 'x' }).success).toBe(false);
    expect(
      emailTemplateUpdateSchema.safeParse({ subject: 'x', body: 'a'.repeat(5001) }).success,
    ).toBe(false);
    const ok = emailTemplateUpdateSchema.safeParse({
      subject: 'Invoice {{invoice_number}}',
      body: 'Hi {{customer_name}},\n\nThanks.',
    });
    expect(ok.success).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { contactCreateSchema } from './contact.js';
import { expenseAllocationsSchema } from './expense.js';
import { invoiceCreateSchema } from './invoice.js';
// Installs the global error map as a side effect, exactly as index.ts does for
// every consumer of the package. Imported for the effect, not the export —
// without it these schemas fall back to Zod's developer wording.
import './messages.js';
import { moneyString, quantityString, taxRateString } from './money.js';

// TMC-221. These messages are read by a landscaper mid-form, so the test is
// about the words, not the shape: the schema already had the right rules and
// still told the user "Too small: expected array to have >=1 items".

// The shape of a machine identifier. If one of these reaches `issue.message`,
// it reaches a screen — every call site renders the message verbatim.
const CODE_SHAPED = /^[a-z]+(_[a-z]+)+$/;

function messagesFor(schema: { safeParse: (v: unknown) => unknown }, input: unknown): string[] {
  const result = schema.safeParse(input) as {
    success: boolean;
    error?: { issues: { message: string }[] };
  };
  expect(result.success).toBe(false);
  return (result.error?.issues ?? []).map((i) => i.message);
}

const validLine = {
  position: 1,
  description: 'Spring cleanup',
  quantity: '1',
  unitPrice: '900.00',
  amount: '900.00',
};

const validInvoice = {
  companyId: '018f0000-0000-7000-8000-000000000000',
  contactId: '018f0000-0000-7000-8000-000000000001',
  number: 'INV-1041',
  issueDate: '2026-06-02',
  dueDate: '2026-07-02',
  subtotal: '900.00',
  tax: '0.00',
  total: '900.00',
  lineItems: [validLine],
};

describe('validation messages — what the user actually reads', () => {
  it('names the thing that is missing rather than the rule that failed', () => {
    expect(messagesFor(invoiceCreateSchema, { ...validInvoice, lineItems: [] })).toContain(
      'Add at least one line.',
    );
    expect(
      messagesFor(invoiceCreateSchema, {
        ...validInvoice,
        lineItems: [{ ...validLine, description: '' }],
      }),
    ).toContain('Give this line a description.');
    expect(
      messagesFor(invoiceCreateSchema, { ...validInvoice, contactId: 'not-a-uuid' }),
    ).toContain('Choose a customer.');
  });

  it('gives money and quantity an example instead of a wire format', () => {
    expect(messagesFor(moneyString, '12.345')).toContain(
      'Enter an amount like 125.00, with no minus sign.',
    );
    expect(messagesFor(moneyString, '-5.00')).toContain(
      'Enter an amount like 125.00, with no minus sign.',
    );
    expect(messagesFor(quantityString, 'lots')).toContain(
      'Enter a quantity like 3 or 1.5, with no minus sign.',
    );
    expect(messagesFor(taxRateString, '825')).toContain("A tax rate can't be more than 100%.");
  });

  // The global map is the part that cannot be forgotten: these validators carry
  // no message of their own and would otherwise emit Zod's own phrasing.
  it('replaces Zod defaults on validators nobody gave a message', () => {
    const blankName = messagesFor(contactCreateSchema, {
      companyId: '018f0000-0000-7000-8000-000000000000',
      name: '',
    });
    expect(blankName).toContain("This can't be blank.");
    expect(blankName.join(' ')).not.toMatch(/Too small|expected string/i);

    const missing = messagesFor(contactCreateSchema, {});
    expect(missing).toContain('This is required.');
    expect(missing.join(' ')).not.toMatch(/Invalid input|expected/i);
  });

  // The regression guard. TMC-159 fixed two codes and the pattern grew back;
  // this fails the build the next time a refine message is written as an
  // identifier rather than a sentence.
  it('never emits a machine identifier as a message', () => {
    const badPayloads: [{ safeParse: (v: unknown) => unknown }, unknown][] = [
      [invoiceCreateSchema, {}],
      [invoiceCreateSchema, { ...validInvoice, lineItems: [] }],
      [invoiceCreateSchema, { ...validInvoice, total: 'free' }],
      [contactCreateSchema, { name: '' }],
      [moneyString, '1.234'],
      [quantityString, '-1'],
      [taxRateString, '101'],
      [
        expenseAllocationsSchema,
        {
          allocations: [
            {
              invoiceId: '018f0000-0000-7000-8000-000000000000',
              jobId: '018f0000-0000-7000-8000-000000000001',
              share: '1',
            },
          ],
        },
      ],
      [expenseAllocationsSchema, { allocations: [{ share: '0.25' }] }],
    ];

    for (const [schema, input] of badPayloads) {
      for (const message of messagesFor(schema, input)) {
        expect(message, `code-shaped message: ${message}`).not.toMatch(CODE_SHAPED);
        expect(message.length, `empty message for ${JSON.stringify(input)}`).toBeGreaterThan(0);
      }
    }
  });
});

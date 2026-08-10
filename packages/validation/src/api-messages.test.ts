import { describe, expect, it } from 'vitest';
import { API_ERROR_MESSAGES, isCodeShaped, messageForApiError } from './api-messages.js';

// TMC-219 / TMC-220. The catalogue is shared by web and mobile so the two
// surfaces cannot drift — they previously held byte-identical copies of a helper
// that covered two codes between them.

describe('isCodeShaped', () => {
  it('recognises the identifiers the API sends', () => {
    for (const code of ['invalid_recipient', 'has_payments', 'period_closed', 'create_failed']) {
      expect(isCodeShaped(code), code).toBe(true);
    }
  });

  it('does not mistake a sentence for one', () => {
    for (const sentence of [
      'Add an email address for this customer before sending.',
      'That could not be saved. Try again.',
      '2025 is closed. Re-open it in the Ledger to record or change anything dated in that year.',
      'empty',
    ]) {
      expect(isCodeShaped(sentence), sentence).toBe(false);
    }
  });
});

describe('the catalogue', () => {
  it('answers the codes a user is most likely to hit', () => {
    // invalid_recipient is the one the ticket was filed for: contact email is
    // optional by design and canSend never checks, so this is the normal path
    // through the most important button in the product.
    expect(messageForApiError('invalid_recipient')).toMatch(/email address/i);
    expect(messageForApiError('has_payments')).toBeTruthy();
    expect(messageForApiError('rate_limited')).toBeTruthy();
    expect(messageForApiError('invalid_body')).toBeTruthy();
  });

  it('returns undefined for a code it has never heard of', () => {
    expect(messageForApiError('some_code_from_the_future')).toBeUndefined();
    expect(messageForApiError(undefined)).toBeUndefined();
  });

  // The guard. Every value in here is rendered verbatim to a user, so a copied
  // key or a placeholder left in place is a code on a screen.
  it('never answers a code with another code', () => {
    for (const [code, message] of Object.entries(API_ERROR_MESSAGES)) {
      expect(isCodeShaped(message), `${code} answers with an identifier`).toBe(false);
      expect(message.length, `${code} has no message`).toBeGreaterThan(0);
    }
  });

  // House style, and the reason the sentences read the way they do. Checking the
  // shape rather than the wording so a copy edit does not fail the build.
  it('writes sentences, not labels', () => {
    for (const [code, message] of Object.entries(API_ERROR_MESSAGES)) {
      expect(message[0], `${code} does not start with a capital`).toBe(message[0]?.toUpperCase());
      expect(message, `${code} does not end a sentence`).toMatch(/[.?!]$/);
    }
  });

  // The vocabulary is not allowed to describe the database. These are the words
  // that leak when someone writes copy from the code rather than from the user.
  it('never names a table, a column or a status enum', () => {
    const forbidden =
      /\b(row|column|table|null|uuid|foreign key|enum|snake_case|account_id|company_id|status code|HTTP)\b/i;
    for (const [code, message] of Object.entries(API_ERROR_MESSAGES)) {
      expect(message, `${code} names an implementation detail`).not.toMatch(forbidden);
    }
  });
});

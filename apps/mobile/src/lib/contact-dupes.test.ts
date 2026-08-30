import { describe, expect, it } from 'vitest';
import { findEmailDupe, findNameDupes } from './contact-dupes';

// Dupe detection during inline contact creation. A miss here means a second
// "Bob's Landscaping" in the customer list; a false hit means the invoice is
// billed to the wrong person.

const list = [
  { id: '1', name: "Bob's Landscaping", email: 'BOB@example.com' },
  { id: '2', name: 'Bobs Landscaping', email: null },
  { id: '3', name: 'Carol Fencing', email: 'carol@example.com' },
];

describe('findEmailDupe', () => {
  it('matches regardless of case or surrounding whitespace', () => {
    expect(findEmailDupe('  bob@example.com ', list)?.id).toBe('1');
  });

  it('finds nothing for a new address', () => {
    expect(findEmailDupe('new@example.com', list)).toBeUndefined();
  });

  it('finds nothing for empty input, rather than matching a null email', () => {
    expect(findEmailDupe('', list)).toBeUndefined();
    expect(findEmailDupe(null, list)).toBeUndefined();
    expect(findEmailDupe(undefined, list)).toBeUndefined();
  });
});

describe('findNameDupes', () => {
  it('ignores punctuation and case, so an apostrophe is not a different customer', () => {
    const hits = findNameDupes('bobs landscaping', list).map((c) => c.id);
    expect(hits).toEqual(['1', '2']);
  });

  it('collapses runs of whitespace', () => {
    expect(findNameDupes('Bobs    Landscaping', list).map((c) => c.id)).toEqual(['1', '2']);
  });

  it('honours the limit', () => {
    expect(findNameDupes('Bobs Landscaping', list, 1).map((c) => c.id)).toEqual(['1']);
  });

  it('returns nothing for empty input', () => {
    expect(findNameDupes('', list)).toEqual([]);
    expect(findNameDupes(null, list)).toEqual([]);
  });

  it('does not match on a partial name', () => {
    expect(findNameDupes('Bobs', list)).toEqual([]);
  });
});

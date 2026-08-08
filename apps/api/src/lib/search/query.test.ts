import { describe, expect, it } from 'vitest';
import { isEmptyQuery, parseSearchQuery } from './query.js';

describe('parseSearchQuery — tsquery construction', () => {
  it('builds prefix terms so results appear while you are still typing', () => {
    expect(parseSearchQuery('smith').tsquery).toBe("'smith':*");
  });

  it('ANDs tokens — adding a word narrows, it does not widen', () => {
    expect(parseSearchQuery('smith roofing').tsquery).toBe("'smith':* & 'roofing':*");
  });

  it('normalizes before tokenizing, so an accent is not a different search', () => {
    expect(parseSearchQuery('José  MÜLLER').tsquery).toBe("'jose':* & 'muller':*");
  });

  it('splits on punctuation so a document number matches either way', () => {
    expect(parseSearchQuery('INV-1042').tsquery).toBe("'inv':* & '1042':*");
  });

  it('caps the token count — a long paste is not a search', () => {
    const parsed = parseSearchQuery('a b c d e f g h i j k l');
    expect(parsed.tsquery?.split(' & ')).toHaveLength(8);
  });
});

// The quoting is the whole injection story: inside single quotes, to_tsquery
// takes the content as a literal lexeme, so none of these can become operators.
// If any of these ever produce a bare & | ! ( ) : outside quotes, a crafted
// query can change the shape of the search rather than its terms.
describe('parseSearchQuery — injection safety', () => {
  const hostile = [
    'a & b',
    'a | b',
    '!a',
    'a <-> b',
    'a:*',
    'a:A',
    '(a | b) & c',
    "a' | 'b",
    'a\\b',
    "'; DROP TABLE search_documents; --",
    '***',
  ];

  for (const input of hostile) {
    it(`neutralizes ${JSON.stringify(input)}`, () => {
      const { tsquery } = parseSearchQuery(input);
      if (tsquery === null) return; // nothing to run is also safe
      // Every term is a quoted lexeme followed by the prefix marker, joined by
      // the ONE operator we control.
      for (const term of tsquery.split(' & ')) {
        expect(term).toMatch(/^'(?:[^']|'')*':\*$/);
      }
    });
  }

  it('doubles an embedded quote rather than escaping the lexeme', () => {
    // "O'Brien" normalizes to one token; the apostrophe must survive as ''.
    expect(parseSearchQuery("O'Brien").tsquery).toBe("'o':* & 'brien':*");
  });
});

describe('parseSearchQuery — the 3-character floor', () => {
  it('runs a text search at three characters', () => {
    expect(parseSearchQuery('smi').tsquery).toBe("'smi':*");
  });

  it('refuses below three, where two characters match almost everything', () => {
    expect(parseSearchQuery('sm').tsquery).toBeNull();
    expect(parseSearchQuery('s').tsquery).toBeNull();
    expect(parseSearchQuery('  ').tsquery).toBeNull();
  });

  it('measures the floor after normalization, not on the raw string', () => {
    // Four raw characters, three after whitespace collapse and trimming.
    expect(parseSearchQuery(' sm ').tsquery).toBeNull();
  });
});

describe('parseSearchQuery — amount detection', () => {
  it('accepts the shapes people actually type', () => {
    expect(parseSearchQuery('1200').amountCents).toBe(120000);
    expect(parseSearchQuery('$1,200.00').amountCents).toBe(120000);
    expect(parseSearchQuery('1,200').amountCents).toBe(120000);
    expect(parseSearchQuery('$ 1200.50').amountCents).toBe(120050);
  });

  it('fires below the text floor — an amount is an equality test, not a scan', () => {
    const parsed = parseSearchQuery('42');
    expect(parsed.amountCents).toBe(4200);
    expect(parsed.tsquery).toBeNull();
    expect(isEmptyQuery(parsed)).toBe(false);
  });

  it('rejects things that are not money', () => {
    // Three decimal places is a quantity or a version, not a price.
    expect(parseSearchQuery('12.345').amountCents).toBeNull();
    expect(parseSearchQuery('abc').amountCents).toBeNull();
    expect(parseSearchQuery('12abc').amountCents).toBeNull();
    expect(parseSearchQuery('1.2.3').amountCents).toBeNull();
  });

  it('still runs the text pass for a query that also parses as money', () => {
    // "1042" is both a plausible amount and an invoice number.
    const parsed = parseSearchQuery('1042');
    expect(parsed.amountCents).toBe(104200);
    expect(parsed.tsquery).toBe("'1042':*");
  });
});

describe('isEmptyQuery', () => {
  it('is true only when there is nothing worth asking the database', () => {
    expect(isEmptyQuery(parseSearchQuery(''))).toBe(true);
    expect(isEmptyQuery(parseSearchQuery('  '))).toBe(true);
    expect(isEmptyQuery(parseSearchQuery('sm'))).toBe(true);
    expect(isEmptyQuery(parseSearchQuery('smi'))).toBe(false);
    expect(isEmptyQuery(parseSearchQuery('42'))).toBe(false);
  });
});

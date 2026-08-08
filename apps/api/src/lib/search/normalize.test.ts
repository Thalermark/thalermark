import { describe, expect, it } from 'vitest';
import { buildBody, digitsOnly, normalizeOrNull, normalizeText } from './normalize.js';

// These functions are load-bearing in a way that is easy to miss: the tsvector
// is GENERATED from the normalized columns, so the query path must normalize
// identically or nothing matches. A regression here does not throw — search
// just quietly stops finding things.
describe('normalizeText', () => {
  it('folds diacritics so an accented name is findable without the accent', () => {
    expect(normalizeText('José')).toBe('jose');
    expect(normalizeText('Müller Roofing')).toBe('muller roofing');
    expect(normalizeText('Ångström')).toBe('angstrom');
    expect(normalizeText('Peña')).toBe('pena');
  });

  it('lowercases', () => {
    expect(normalizeText('INV-1042')).toBe('inv-1042');
  });

  it('collapses and trims whitespace', () => {
    expect(normalizeText('  Smith   Roofing \n LLC  ')).toBe('smith roofing llc');
    expect(normalizeText('\t\tgutter\t\tcleaning\t')).toBe('gutter cleaning');
  });

  it('folds compatibility forms via NFKC', () => {
    // Full-width characters and ligatures reach us from pasted PDFs.
    expect(normalizeText('ＩＮＶ－１０４２')).toBe('inv-1042');
    expect(normalizeText('ﬁnal invoice')).toBe('final invoice');
  });

  it('is idempotent — normalizing twice equals normalizing once', () => {
    const once = normalizeText('  José   MÜLLER  ');
    expect(normalizeText(once)).toBe(once);
  });

  it('leaves an empty string empty rather than throwing', () => {
    expect(normalizeText('')).toBe('');
    expect(normalizeText('   ')).toBe('');
  });
});

describe('digitsOnly', () => {
  it('extracts the digit run so a bare number finds a formatted phone', () => {
    expect(digitsOnly('(555) 123-4567')).toBe('5551234567');
    expect(digitsOnly('+1 555.123.4567')).toBe('15551234567');
  });

  it('returns null when there is nothing to index', () => {
    expect(digitsOnly(null)).toBeNull();
    expect(digitsOnly(undefined)).toBeNull();
    expect(digitsOnly('')).toBeNull();
    expect(digitsOnly('no digits here')).toBeNull();
  });
});

describe('buildBody', () => {
  it('joins the parts that have content', () => {
    expect(buildBody(['gutter cleaning', 'and repair'])).toBe('gutter cleaning and repair');
  });

  it('drops nulls and blanks instead of joining empty separators', () => {
    expect(buildBody([null, 'memo', undefined, '   ', 'note'])).toBe('memo note');
  });

  it('returns null when nothing has content, so the column stays NULL', () => {
    expect(buildBody([])).toBeNull();
    expect(buildBody([null, undefined, '  '])).toBeNull();
  });

  it('caps the result — GIN rejects a tsvector over 1MB, so this is correctness', () => {
    const huge = buildBody([['gutter cleaning'].join(' ').repeat(500)]);
    expect(huge).not.toBeNull();
    expect((huge as string).length).toBe(2000);
  });
});

describe('normalizeOrNull', () => {
  it('normalizes content and preserves null for absent text', () => {
    expect(normalizeOrNull('  José  ')).toBe('jose');
    expect(normalizeOrNull(null)).toBeNull();
    expect(normalizeOrNull(undefined)).toBeNull();
    expect(normalizeOrNull('   ')).toBeNull();
  });
});

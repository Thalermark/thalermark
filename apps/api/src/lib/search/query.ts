import { SEARCH_MIN_TEXT_CHARS, toCents } from '@thalermark/validation';
import { normalizeText } from './normalize.js';

// A search box query is a longer paste than a search past this. Capping the
// token count bounds how many AND-ed prefix terms the tsquery can carry, which
// is what stops a pasted paragraph from becoming an expensive query.
const MAX_TOKENS = 8;

// What "1,200" or "$1,200.00" looks like. Anchored, and it deliberately does
// NOT accept "12.345" — three decimal places is a quantity or a version number,
// not money.
const MONEY_RE = /^\$?\s*\d{1,13}(,\d{3})*(\.\d{1,2})?$/;

export type ParsedQuery = {
  // Postgres tsquery text, already quoted and prefix-suffixed. Bound as a
  // parameter to to_tsquery('simple', $1) — never interpolated.
  tsquery: string | null;
  // The normalized raw string, for the trigram (typo-tolerance) pass.
  trgm: string | null;
  // Set when the query parses as money, so an exact amount match can rank.
  amountCents: number | null;
};

// Turn one lexeme into a quoted prefix term.
//
// THE QUOTING IS THE INJECTION STORY. Inside single quotes, to_tsquery treats
// the content as a literal lexeme, so `&`, `|`, `!`, `(`, `)`, `:` and `*` in
// user input cannot become operators — a query of `a & b` searches for the
// three literal tokens, it does not build a conjunction. Embedded quotes are
// doubled, the standard SQL-string escape, which is why a lone apostrophe in
// "O'Brien" is harmless.
function toPrefixTerm(token: string): string {
  return `'${token.replace(/'/g, "''")}':*`;
}

// Parse a raw search box string into the three predicates the index supports.
//
// Prefix matching (`:*`) rather than websearch_to_tsquery, deliberately: a box
// that only matches whole words feels broken while you are still typing, which
// is precisely when a search-as-you-type dropdown is being read.
export function parseSearchQuery(raw: string): ParsedQuery {
  const trimmed = raw.trim();
  if (trimmed === '') return { tsquery: null, trgm: null, amountCents: null };

  // Amount detection runs on the RAW string, before normalization strips the
  // currency symbol and separators. Exempt from the character floor: matching
  // an amount is an equality test against an indexed bigint, not a text scan,
  // so "42" is a legitimate two-character search where "ab" is not.
  let amountCents: number | null = null;
  if (MONEY_RE.test(trimmed)) {
    const cleaned = trimmed.replace(/[$,\s]/g, '');
    const parsed = toCents(cleaned);
    amountCents = Number.isFinite(parsed) ? parsed : null;
  }

  const normalized = normalizeText(trimmed);
  if (normalized.length < SEARCH_MIN_TEXT_CHARS) {
    // Too short to search text, but an amount may still be worth running.
    return { tsquery: null, trgm: null, amountCents };
  }

  const tokens = normalized.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0);
  if (tokens.length === 0) return { tsquery: null, trgm: null, amountCents };

  // AND between tokens, because "smith roof" means both — someone narrowing a
  // query by adding a word expects fewer results, not more.
  const tsquery = tokens.slice(0, MAX_TOKENS).map(toPrefixTerm).join(' & ');

  return { tsquery, trgm: normalized, amountCents };
}

// True when there is nothing worth asking the database.
export function isEmptyQuery(parsed: ParsedQuery): boolean {
  return parsed.tsquery === null && parsed.amountCents === null && parsed.trgm === null;
}

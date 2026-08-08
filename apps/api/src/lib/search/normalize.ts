// Text normalization for global search (TMC-198).
//
// The projector and the query path MUST use these same functions. The tsvector
// is generated from the normalized columns, so a query normalized differently
// simply will not match — accent-folding one side and not the other is a silent
// "search is broken for José" bug.
//
// This lives in TypeScript rather than in SQL because unaccent() is STABLE, not
// IMMUTABLE, and so cannot appear in a generated column or index expression
// without the well-known immutable_unaccent wrapper — a wrapper that lies to
// the planner and silently corrupts the index if the dictionary ever changes.
// Doing it here is also unit-testable, which that wrapper is not.

// GIN rejects a tsvector over 1MB outright, so an uncapped body would throw on
// insert for a large enough invoice. This is a correctness bound, not a tuning
// knob. 2000 characters is roughly 300 words — far past the point where more
// line-item text improves a match.
const MAX_BODY_CHARS = 2000;

// NFKC first so compatibility forms fold (ﬁ -> fi, full-width -> ASCII), then
// NFD to split base characters from their diacritics so the marks can be
// stripped. Lowercase before stripping: some locales' uppercase forms carry
// marks that would otherwise survive.
export function normalizeText(input: string): string {
  return input
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Phone numbers are stored however the user typed them. Indexing the digits
// alongside the display form is what makes "5551234" find "(555) 123-4567" —
// the tokenizer would otherwise treat the punctuation as word boundaries and
// never produce a lexeme that matches a bare digit run.
export function digitsOnly(input: string | null | undefined): string | null {
  if (!input) return null;
  const digits = input.replace(/\D/g, '');
  return digits.length > 0 ? digits : null;
}

// Joins the non-empty parts of a document body and caps the result. Nulls and
// blanks are dropped rather than joined into runs of separators, which would
// otherwise produce empty lexemes.
export function buildBody(parts: (string | null | undefined)[]): string | null {
  const joined = parts
    .map((p) => p?.trim())
    .filter((p): p is string => !!p)
    .join(' ');
  if (joined === '') return null;
  return joined.length > MAX_BODY_CHARS ? joined.slice(0, MAX_BODY_CHARS) : joined;
}

// Normalize for indexing, preserving null so the column stays NULL rather than
// becoming an empty string (coalesce in the generated column handles both, but
// NULL is the honest representation of "this entity has no such text").
export function normalizeOrNull(input: string | null | undefined): string | null {
  if (!input) return null;
  const normalized = normalizeText(input);
  return normalized === '' ? null : normalized;
}

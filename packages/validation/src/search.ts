// Global search (TMC-198). Shared between the API, web and mobile so the three
// agree on what is searchable and when a query is worth sending.

// The entities projected into search_documents. Adding an eighth is a projector
// plus one entry here — deliberately not a pg enum, so it is not a migration.
export const SEARCH_ENTITY_TYPES = [
  'invoice',
  'estimate',
  'contact',
  'expense',
  'bill',
  'job',
  'item',
] as const;

export type SearchEntityType = (typeof SEARCH_ENTITY_TYPES)[number];

export function isSearchEntityType(value: string): value is SearchEntityType {
  return (SEARCH_ENTITY_TYPES as readonly string[]).includes(value);
}

// Three characters before a text search runs.
//
// Not the 2 the contact/item pickers use. Those search one column of one small
// table; this fans across seven entity types and every note and line-item
// description in the account, where two characters match almost everything and
// the result is noise the user has to read past. Three is also the trigram
// floor — a 1-2 character query cannot use the fuzzy index at all — so below it
// there is nothing useful to run.
//
// A purely numeric query is exempt: it matches amounts and document numbers by
// equality, not by scanning text, so "42" is a legitimate search.
export const SEARCH_MIN_TEXT_CHARS = 3;

// The dropdown shows at most this many hits per entity type, so one noisy type
// cannot crowd out the others. The full results page has no such cap.
export const SEARCH_GROUP_LIMIT = 3;

// Ranked results are a top-N, not a browsable list. Paging past this many is a
// sign the query is too broad, and the per-entity lists (which have their own
// filters and keyset pagination) are the better tool from there.
export const SEARCH_MAX_DEPTH = 500;

// One hit, as the API returns it. Money is a decimal string, per the repo-wide
// rule that money never crosses the wire as a float.
export type SearchResult = {
  entityType: SearchEntityType;
  entityId: string;
  companyId: string;
  title: string;
  subtitle: string | null;
  status: string | null;
  amount: string | null;
  occurredOn: string | null;
  score: number;
};

export type SearchResponse = {
  query: string;
  results: SearchResult[];
  counts: Partial<Record<SearchEntityType, number>>;
  hasMore: boolean;
};

import { type Column, type SQL, and, eq, gt, lt, or, sql } from 'drizzle-orm';

// Keyset (cursor) pagination helpers shared by the list endpoints.
//
// Why keyset and not offset: every list is account-scoped and grows without
// bound; a deep OFFSET scan is exactly what degrades at volume. Keyset on a
// unique sort tuple (a sort column + the row id tiebreak) is stable under
// concurrent inserts and stays flat as rows grow. The wire contract is
// `?cursor=&limit=` -> `{ <rows>, nextCursor }`.

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// Parse the ?limit= query param. Returns the clamped page size, or null when
// the value is present but malformed (caller should 400). Absent => default.
export function parseLimit(
  raw: string | undefined,
  opts: { def?: number; max?: number } = {},
): number | null {
  const def = opts.def ?? DEFAULT_LIMIT;
  const max = opts.max ?? MAX_LIMIT;
  if (raw === undefined) return def;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.min(parsed, max);
}

// A cursor is the opaque, base64url-encoded JSON of the previous page's last
// row's sort-key values (in sort order). Dates serialize to ISO strings; the
// caller reconstructs the right runtime type when handing values back to
// keysetWhere (e.g. `new Date(cursor[0])` for a timestamp column).
export function encodeCursor(values: unknown[]): string {
  return Buffer.from(JSON.stringify(values), 'utf8').toString('base64url');
}

// Decode a cursor. Returns null on any garbage (caller should 400).
export function decodeCursor(raw: string): unknown[] | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Build the keyset WHERE predicate for "rows strictly after the cursor" given
// the ordered sort keys (column + already-typed value) and a single direction
// shared by every key. Expands to the standard lexicographic comparison:
//   desc 2-col -> (c0 < v0) OR (c0 = v0 AND c1 < v1)
// using drizzle ops so values bind through each column's own type mapping (no
// raw casts). All our list sorts are single-direction, so one `dir` suffices.
export function keysetWhere(keys: { col: Column; value: unknown }[], dir: 'asc' | 'desc'): SQL {
  const op = dir === 'desc' ? lt : gt;
  const clauses: SQL[] = [];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i] as { col: Column; value: unknown };
    const prefix = keys.slice(0, i).map((k) => eq(k.col, k.value));
    // biome-ignore lint/style/noNonNullAssertion: and() with >=1 arg is non-null
    clauses.push(and(...prefix, op(key.col, key.value))!);
  }
  // biome-ignore lint/style/noNonNullAssertion: keys is always non-empty here
  return or(...clauses)!;
}

// Sort key for one list endpoint: the ordered columns + how to revive each
// value out of a (string-ish) decoded cursor back into the type the column
// binds (e.g. `new Date` for a timestamp column). The last key MUST be a
// unique tiebreak (the row id) so the tuple is a total order.
export type KeyDef = { col: Column; revive?: (v: unknown) => unknown };

// Turn the ?cursor= query value into a keyset predicate to push into the
// WHERE. Returns null when there's no cursor (page 1), 'invalid' when the
// cursor is malformed (caller should 400), else the SQL predicate.
export function applyCursor(
  cursorRaw: string | undefined,
  keys: KeyDef[],
  dir: 'asc' | 'desc',
): SQL | null | 'invalid' {
  if (cursorRaw === undefined) return null;
  const cursor = decodeCursor(cursorRaw);
  if (!cursor || cursor.length !== keys.length) return 'invalid';
  return keysetWhere(
    keys.map((k, i) => ({ col: k.col, value: k.revive ? k.revive(cursor[i]) : cursor[i] })),
    dir,
  );
}

// ORDER BY clause matching a KeyDef list. Emits NULLS LAST explicitly so the
// ordering matches the keyset btree indexes (drizzle-kit writes index columns
// as `DESC NULLS LAST`, but a bare `ORDER BY x DESC` defaults to NULLS FIRST —
// the mismatch would force a sort instead of an ordered index scan). Columns
// are NOT NULL so the null placement is cosmetic; only the match matters.
export function keysetOrderBy(keys: KeyDef[], dir: 'asc' | 'desc'): SQL {
  const dirSql = sql.raw(dir === 'desc' ? 'desc nulls last' : 'asc nulls last');
  return sql.join(
    keys.map((k) => sql`${k.col} ${dirSql}`),
    sql`, `,
  );
}

// Given limit+1 fetched rows, peel off the extra to detect a next page and
// build its cursor from the last kept row's sort-key values. `keyOf` must
// return the same values, in the same order, as the endpoint's KeyDef list.
export function slicePage<T>(
  rows: T[],
  limit: number,
  keyOf: (row: T) => unknown[],
): { rows: T[]; nextCursor: string | null } {
  if (rows.length > limit) {
    const last = rows[limit - 1] as T;
    return { rows: rows.slice(0, limit), nextCursor: encodeCursor(keyOf(last)) };
  }
  return { rows, nextCursor: null };
}

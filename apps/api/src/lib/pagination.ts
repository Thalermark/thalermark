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
//
// Retained for the value-carrying form, but note that NO list endpoint uses it
// for a timestamp any more — see keysetWhereFromRow and TMC-193 for why.
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

// The same comparison, but with the sort-key values resolved BY POSTGRES from
// the cursor row rather than carried through the cursor (TMC-193).
//
// THE BUG THIS EXISTS TO KILL. `created_at` is timestamptz — microsecond
// precision. Round-tripping it through a JS `Date` (millisecond precision) to
// build the cursor silently truncated it, so for a row stored at `…:00.574485`
// the predicate became `created_at < '…:00.574'`: strictly greater, and not
// equal either, so NEITHER branch matched and the next page came back empty.
// Every row sharing that timestamp became unreachable. Any bulk insert produces
// exactly that shape, because `defaultNow()` is the transaction timestamp and
// is identical for every row written in one statement — a 500-row CSV import
// was mostly invisible past page one.
//
// The fix is to never let the timestamp leave the database. The cursor carries
// only the row id (a uuid, which round-trips as text losslessly), and the
// comparison expands to a row-value expression whose leading values come from a
// scalar subquery:
//
//   (created_at, id) < ((SELECT created_at FROM invoices WHERE id = $1), $1)
//
// Properties worth keeping in mind:
//   * Exact. The comparison happens entirely in Postgres at full precision.
//   * Index-friendly. Row-value comparison on (created_at, id) still uses the
//     existing (account_id, created_at, id) keyset indexes — no new index and
//     no migration, which the id-only-ordering alternative would have needed.
//   * Tenant-safe by accident, and pleasantly so: the subquery runs under the
//     same RLS context, so a cursor forged from another account's row resolves
//     to NULL and yields an empty page rather than leaking a position.
//   * An unknown id likewise yields NULL and an empty page.
function keysetWhereFromRow(keys: KeyDef[], dir: 'asc' | 'desc', cursorId: string): SQL {
  const idKey = keys[keys.length - 1] as KeyDef;
  const leading = keys.slice(0, -1);
  const table = (idKey.col as unknown as { table: unknown }).table;
  const op = sql.raw(dir === 'desc' ? '<' : '>');

  // Single-key case: the id alone is already a total order, so no subquery.
  if (leading.length === 0) {
    return sql`${idKey.col} ${op} ${cursorId}`;
  }

  const lhs = sql.join([...leading.map((k) => sql`${k.col}`), sql`${idKey.col}`], sql`, `);
  const rhs = sql.join(
    [
      ...leading.map((k) => sql`(select ${k.col} from ${table} where ${idKey.col} = ${cursorId})`),
      sql`${cursorId}`,
    ],
    sql`, `,
  );
  return sql`(${lhs}) ${op} (${rhs})`;
}

// Sort key for one list endpoint: the ordered columns + how to revive each
// value out of a (string-ish) decoded cursor back into the type the column
// binds (e.g. `new Date` for a timestamp column). The last key MUST be a
// unique tiebreak (the row id) so the tuple is a total order.
export type KeyDef = { col: Column; revive?: (v: unknown) => unknown };

// Turn the ?cursor= query value into a keyset predicate to push into the
// WHERE. Returns null when there's no cursor (page 1), 'invalid' when the
// cursor is malformed (caller should 400), else the SQL predicate.
// The cursor is the previous page's last row ID, base64url-encoded as a
// one-element array (the array wrapper is kept so the wire format and
// decodeCursor are unchanged from the value-carrying version).
//
// Older cursors carried every sort-key value. Those still decode — the last
// element has always been the row id — so a cursor held by an open page or a
// bookmarked URL keeps working across the deploy rather than 400ing.
export function applyCursor(
  cursorRaw: string | undefined,
  keys: KeyDef[],
  dir: 'asc' | 'desc',
): SQL | null | 'invalid' {
  if (cursorRaw === undefined) return null;
  const cursor = decodeCursor(cursorRaw);
  if (!cursor || cursor.length === 0) return 'invalid';
  // Last element is the row id, in both the new one-element form and the
  // legacy full-tuple form.
  const cursorId = cursor[cursor.length - 1];
  if (typeof cursorId !== 'string' || !UUID_CURSOR_RE.test(cursorId)) return 'invalid';
  return keysetWhereFromRow(keys, dir, cursorId);
}

// Local copy rather than importing from route-helpers — pagination is a leaf
// utility and should not depend on the route layer.
const UUID_CURSOR_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
// `keyOf` still returns the full sort tuple — every call site passes
// `(r) => [r.createdAt, r.id]` and none of them had to change — but only the
// LAST element (the row id) is encoded. The leading values are resolved by
// Postgres at query time instead, which is what keeps microseconds intact.
// See keysetWhereFromRow and TMC-193.
export function slicePage<T>(
  rows: T[],
  limit: number,
  keyOf: (row: T) => unknown[],
): { rows: T[]; nextCursor: string | null } {
  if (rows.length > limit) {
    const last = rows[limit - 1] as T;
    const key = keyOf(last);
    const id = key[key.length - 1];
    return { rows: rows.slice(0, limit), nextCursor: encodeCursor([id]) };
  }
  return { rows, nextCursor: null };
}

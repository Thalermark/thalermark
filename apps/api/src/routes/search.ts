import {
  SEARCH_ENTITY_TYPES,
  SEARCH_GROUP_LIMIT,
  SEARCH_MAX_DEPTH,
  type SearchEntityType,
  type SearchResult,
  centsToMoney,
  isSearchEntityType,
} from '@thalermark/validation';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppDeps } from '../app.js';
import { parseLimit } from '../lib/pagination.js';
import { isEmptyQuery, parseSearchQuery } from '../lib/search/query.js';
import { RATE_LIMITS, rateLimit } from '../middleware/rate-limit.js';
import type { RlsVariables } from '../middleware/rls-context.js';

// Global search (TMC-198) — one box across invoices, estimates, contacts,
// expenses, bills, jobs and items.
//
// NO CAPABILITY GATE, on purpose. Reads are ungated for all five roles by design
// (packages/validation/src/roles.ts): the capability model gates mutations, and
// every role may already GET every list this searches. A gate here would be the
// only read gate in the app and would imply a read model that does not exist.
// Pinned by a test asserting a viewer can call it.
//
// THE ACCOUNT IS THE SECURITY BOUNDARY, not the company. companyId is an
// optional narrowing filter, exactly as it is on every list endpoint — RLS pins
// account_id only, and "find it across all my businesses" is a legitimate need
// for a workspace with several companies.

// A row as the two-stage read returns it. Raw because it comes back through
// sql`` rather than a drizzle select.
type HitRow = {
  entity_type: string;
  entity_id: string;
  company_id: string;
  title: string;
  subtitle: string | null;
  status: string | null;
  amount_cents: string | number | null;
  occurred_on: string | null;
  score: number;
};

function toResult(row: HitRow): SearchResult {
  return {
    entityType: row.entity_type as SearchEntityType,
    entityId: row.entity_id,
    companyId: row.company_id,
    title: row.title,
    subtitle: row.subtitle,
    status: row.status,
    // node-postgres hands back bigint as a string to avoid precision loss.
    // Money crosses the wire as a decimal string, per the repo-wide rule.
    amount: row.amount_cents === null ? null : centsToMoney(Number(row.amount_cents)),
    occurredOn: row.occurred_on,
    score: Number(row.score),
  };
}

// Caps each entity type so one noisy type cannot crowd the dropdown. Applied in
// TS over an overfetched, already-ranked set rather than in SQL, because a
// per-type LIMIT would need a lateral join per type and the overfetch is cheap.
function groupCap(results: SearchResult[], limit: number): SearchResult[] {
  const seen = new Map<SearchEntityType, number>();
  const out: SearchResult[] = [];
  for (const r of results) {
    const count = seen.get(r.entityType) ?? 0;
    if (count >= SEARCH_GROUP_LIMIT) continue;
    seen.set(r.entityType, count + 1);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

export function searchRoutes(deps: AppDeps) {
  return new Hono<{ Variables: RlsVariables }>().get(
    '/api/search',
    rateLimit(deps, RATE_LIMITS.search, (c) => c.get('accountId')),
    async (c) => {
      const tx = c.get('tx');
      const raw = c.req.query('q') ?? '';

      // Over-long is a 400 (something is wrong upstream); too short is a 200
      // with no results, because the client debounces and should not have to
      // special-case the boundary between "keep typing" and "nothing matched".
      if (raw.length > 200) return c.json({ error: 'invalid_query' }, 400);

      const limit = parseLimit(c.req.query('limit'), { def: 10, max: 50 });
      if (limit === null) return c.json({ error: 'invalid_limit' }, 400);

      const offsetRaw = c.req.query('offset');
      const offset = offsetRaw === undefined ? 0 : Number.parseInt(offsetRaw, 10);
      if (!Number.isFinite(offset) || offset < 0) return c.json({ error: 'invalid_offset' }, 400);

      const typesRaw = c.req.query('types');
      let types: SearchEntityType[] | null = null;
      if (typesRaw !== undefined && typesRaw !== '') {
        const parsed = typesRaw.split(',').map((t) => t.trim());
        if (!parsed.every(isSearchEntityType)) return c.json({ error: 'invalid_types' }, 400);
        types = parsed as SearchEntityType[];
      }

      const grouped = c.req.query('group') === '1';
      const companyId = c.req.query('companyId') ?? null;
      const parsed = parseSearchQuery(raw);

      const empty = { query: raw, results: [], counts: {}, hasMore: false };
      if (isEmptyQuery(parsed)) return c.json(empty);

      // How deep the ranked set has to go. Grouped mode overfetches so the
      // per-type cap still has something to choose from after trimming; paged
      // mode needs offset+limit because each pass inside the function is
      // LIMITed and cannot skip ahead on its own.
      //
      // Depth is capped: ranked results are a top-N, not a browsable list, and
      // past this the per-entity lists (with their own filters and keyset
      // pagination) are the right tool. hasMore stays true at the ceiling so the
      // client can say so rather than implying it reached the end.
      const wanted = grouped ? Math.max(limit * 4, 40) : offset + limit + 1;
      const depth = Math.min(wanted, SEARCH_MAX_DEPTH);

      // Two stages, and the second one is the fence.
      //
      // search_documents_match() runs as its owner so the GIN index is usable
      // (see migration 0034 — no text operator in PG 17 is leakproof, so under
      // RLS the index would go unused). It returns keys and a score only. The
      // join then re-reads the rows THROUGH RLS, so the policy remains the
      // authority on what this account can see: an id the function should not
      // have returned simply fails to join. texteq and uuid_eq are both
      // leakproof, so that join is still a primary-key index scan under RLS.
      const rows = await tx.execute<HitRow>(sql`
        WITH hits AS (
          SELECT * FROM search_documents_match(
            ${parsed.tsquery === null ? sql`NULL::tsquery` : sql`to_tsquery('simple', ${parsed.tsquery})`},
            ${parsed.trgm},
            ${parsed.amountCents},
            ${companyId}::uuid,
            ${
              types === null
                ? sql`NULL::text[]`
                : // Each element bound separately rather than handing the driver
                  // a JS array: node-postgres does not serialize one into a
                  // text[] parameter here, and it fails at the cast.
                  sql`ARRAY[${sql.join(
                    types.map((t) => sql`${t}`),
                    sql`, `,
                  )}]::text[]`
            },
            ${depth}
          )
        )
        SELECT d.entity_type, d.entity_id, d.company_id, d.title, d.subtitle,
               d.status, d.amount_cents, d.occurred_on, h.score
        FROM hits h
        JOIN search_documents d
          ON d.entity_type = h.entity_type AND d.entity_id = h.entity_id
        ORDER BY h.score DESC, d.entity_updated_at DESC, d.entity_id DESC
      `);

      const all = rows.rows.map(toResult);
      const page = grouped ? groupCap(all, limit) : all.slice(offset, offset + limit);

      // Counts describe the returned page, not the true totals — the function
      // is LIMITed, so an exact total would mean a second unbounded scan.
      const counts: Partial<Record<SearchEntityType, number>> = {};
      for (const type of SEARCH_ENTITY_TYPES) {
        const n = page.filter((r) => r.entityType === type).length;
        if (n > 0) counts[type] = n;
      }

      return c.json({
        query: raw,
        results: page,
        counts,
        hasMore: grouped ? all.length > page.length : all.length > offset + limit,
      });
    },
  );
}

export type SearchAppType = ReturnType<typeof searchRoutes>;

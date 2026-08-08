import {
  bills,
  contacts,
  estimates,
  expenses,
  invoices,
  items,
  jobs,
  searchDocuments,
} from '@thalermark/db';
import { SEARCH_ENTITY_TYPES, type SearchEntityType } from '@thalermark/validation';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { normalizeOrNull, normalizeText } from './normalize.js';
import { PROJECTORS } from './projectors.js';
import type { SearchHandle, SearchKey } from './types.js';

// Postgres caps a statement at 65535 bound parameters. A document binds ~15, so
// 500 rows is ~7500 — comfortably inside, and small enough that one oversized
// CSV import does not build a single enormous statement.
const CHUNK = 500;

function chunked<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

// Re-project the named entities and reconcile the index to match.
//
// This is the ONLY writer of search_documents. It is deliberately total: for
// every id handed in, either a document is written or any existing one is
// deleted. There is no "update" path that can leave a stale row behind, and no
// caller has to know whether the entity still exists.
export async function reindexEntities(
  handle: SearchHandle,
  accountId: string,
  keys: SearchKey[],
): Promise<void> {
  if (keys.length === 0) return;

  const byType = new Map<SearchEntityType, Set<string>>();
  for (const key of keys) {
    const set = byType.get(key.entityType);
    if (set) set.add(key.entityId);
    else byType.set(key.entityType, new Set([key.entityId]));
  }

  for (const [entityType, idSet] of byType) {
    const projector = PROJECTORS[entityType];
    for (const ids of chunked([...idSet], CHUNK)) {
      const documents = await projector(handle, accountId, ids);

      if (documents.length > 0) {
        await handle
          .insert(searchDocuments)
          .values(
            documents.map((d) => ({
              entityType: d.entityType,
              entityId: d.entityId,
              accountId,
              companyId: d.companyId,
              title: d.title,
              subtitle: d.subtitle,
              titleNorm: normalizeText(d.title),
              refNorm: normalizeOrNull(d.ref),
              subtitleNorm: normalizeOrNull(d.subtitle),
              bodyNorm: normalizeOrNull(d.body),
              status: d.status,
              amountCents: d.amountCents,
              occurredOn: d.occurredOn,
              entityUpdatedAt: d.entityUpdatedAt,
              indexedAt: new Date(),
            })),
          )
          .onConflictDoUpdate({
            target: [searchDocuments.entityType, searchDocuments.entityId],
            set: {
              // company_id is in the update set on purpose: an entity can move
              // between companies (company copy-from, the incorporation
              // handoff), and a document left pointing at the old company would
              // be invisible to the new one's scoped search.
              companyId: sql`excluded.company_id`,
              title: sql`excluded.title`,
              subtitle: sql`excluded.subtitle`,
              titleNorm: sql`excluded.title_norm`,
              refNorm: sql`excluded.ref_norm`,
              subtitleNorm: sql`excluded.subtitle_norm`,
              bodyNorm: sql`excluded.body_norm`,
              status: sql`excluded.status`,
              amountCents: sql`excluded.amount_cents`,
              occurredOn: sql`excluded.occurred_on`,
              entityUpdatedAt: sql`excluded.entity_updated_at`,
              // Stamped on every write, which is what lets the sweep reap by
              // "older than my run start" without erasing concurrent writes.
              indexedAt: sql`excluded.indexed_at`,
            },
          });
      }

      // Anything the projector declined to return no longer belongs in the
      // index: hard-deleted, soft-deleted, or moved out of scope. One delete
      // covers all three, which is why no caller ever signals "this was a
      // delete".
      const kept = new Set(documents.map((d) => d.entityId));
      const gone = ids.filter((id) => !kept.has(id));
      if (gone.length > 0) {
        await handle
          .delete(searchDocuments)
          .where(
            and(
              eq(searchDocuments.accountId, accountId),
              eq(searchDocuments.entityType, entityType),
              inArray(searchDocuments.entityId, gone),
            ),
          );
      }
    }
  }
}

const COMPANY_SCOPED_SOURCES = {
  invoice: invoices,
  estimate: estimates,
  contact: contacts,
  expense: expenses,
  bill: bills,
  job: jobs,
  item: items,
} as const;

// Re-project every searchable row in one company.
//
// Used where a single operation creates rows in bulk without per-row audit
// events — the company copy-from path, and the incorporation handoff that runs
// through it. Whole-company reprojection rather than tracking ids per section
// because it is immune to someone adding an eighth copied entity type and
// forgetting to thread it through; guardSize() already bounds how big a copy
// can be.
export async function reindexCompany(
  handle: SearchHandle,
  accountId: string,
  companyId: string,
): Promise<void> {
  for (const entityType of SEARCH_ENTITY_TYPES) {
    const table = COMPANY_SCOPED_SOURCES[entityType];
    const rows = await handle
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.accountId, accountId), eq(table.companyId, companyId)));
    if (rows.length === 0) continue;
    await reindexEntities(
      handle,
      accountId,
      rows.map((r) => ({ entityType, entityId: r.id })),
    );
  }
}

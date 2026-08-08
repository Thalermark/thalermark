import { type Database, accounts, searchDocuments, withAccountContext } from '@thalermark/db';
import { getLogger } from '@thalermark/logger';
import { SEARCH_ENTITY_TYPES } from '@thalermark/validation';
import { type SQL, and, asc, eq, gt, lt } from 'drizzle-orm';
import { SEARCH_SOURCE_TABLES, reindexEntities } from './reindex.js';

const log = getLogger(['api', 'search-sweep']);

// Rows read from a source table per page, and entities reprojected per
// transaction. Small enough that a large tenant never holds one long-running
// transaction, which is the whole reason this is chunked rather than
// per-account.
const PAGE = 500;

export type SearchSweepResult = {
  accounts: number;
  documents: number;
  reaped: number;
  failed: number;
};

// Rebuild the search index from the source rows, then reap anything stale.
//
// TWO JOBS, and the second is the one that matters. Backfilling an empty table
// after deploy is the obvious one. The other is self-healing: the request-path
// reindex hangs off the audit writer, which is a convention rather than an
// enforcement point, so a mutation path that forgets to audit will silently
// drift. Reaping every document this run did not touch turns that from a
// permanent, invisible correctness bug into a bounded staleness window.
//
// The reap is by `indexed_at < runStartedAt` rather than by comparing id sets,
// which is what makes it safe to run against a live system: a document written
// by a concurrent request during the sweep carries a newer indexed_at and
// survives, while one whose entity vanished is never re-stamped and goes.
//
// Deliberately NOT entitlement-gated, same reasoning as the depreciation sweep:
// a stale index is a correctness problem, not a feature to withhold from a
// lapsed account.
export async function sweepSearchReindex(args: {
  bootstrapDb: Database;
  tenantDb: Database;
  accountId?: string;
}): Promise<SearchSweepResult> {
  const targets = args.accountId
    ? [{ id: args.accountId }]
    : await args.bootstrapDb.select({ id: accounts.id }).from(accounts).orderBy(asc(accounts.id));

  const result: SearchSweepResult = { accounts: 0, documents: 0, reaped: 0, failed: 0 };

  for (const account of targets) {
    // Stamped BEFORE any work for this account. Anything left carrying an older
    // indexed_at at the end was not reachable from a source row.
    const runStartedAt = new Date();
    try {
      for (const entityType of SEARCH_ENTITY_TYPES) {
        const table = SEARCH_SOURCE_TABLES[entityType];
        let cursor: string | null = null;

        for (;;) {
          // Both annotations are load-bearing, not decoration: SEARCH_SOURCE_TABLES
          // is a union of seven table types, so `table.id` is a union of columns
          // and drizzle's builder cannot infer a result type through it. Without
          // them tsc reports TS7022 on a circular initializer, because `cursor`
          // is assigned from the very query whose type it is trying to infer.
          const where: SQL | undefined = cursor
            ? and(eq(table.accountId, account.id), gt(table.id, cursor))
            : eq(table.accountId, account.id);
          const page: { id: string }[] = await args.bootstrapDb
            .select({ id: table.id })
            .from(table)
            .where(where)
            .orderBy(asc(table.id))
            .limit(PAGE);
          if (page.length === 0) break;

          // One transaction per page, never one per account: a tenant with
          // 100k rows would otherwise hold a single transaction open long
          // enough to block vacuum and pin a pooled connection.
          await withAccountContext(args.tenantDb, { accountId: account.id }, async (tx) => {
            await reindexEntities(
              tx,
              account.id,
              page.map((row) => ({ entityType, entityId: row.id })),
            );
          });

          result.documents += page.length;
          cursor = page[page.length - 1]?.id ?? null;
          if (page.length < PAGE) break;
        }
      }

      const reaped = await withAccountContext(
        args.tenantDb,
        { accountId: account.id },
        async (tx) =>
          tx
            .delete(searchDocuments)
            .where(
              and(
                eq(searchDocuments.accountId, account.id),
                lt(searchDocuments.indexedAt, runStartedAt),
              ),
            )
            .returning({ entityId: searchDocuments.entityId }),
      );
      result.reaped += reaped.length;
      result.accounts += 1;
    } catch (err) {
      // One account failing is logged and skipped. Its index stays as it was —
      // stale, not wrong — and the next run retries it, because the sweep
      // recomputes everything from the source rows rather than tracking state.
      result.failed += 1;
      log.error('search reindex failed for account {id}: {msg}', {
        id: account.id,
        msg: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (result.documents > 0 || result.reaped > 0 || result.failed > 0) {
    log.info(
      'search reindex: {documents} projected, {reaped} reaped across {accounts} accounts ({failed} failed)',
      result,
    );
  }
  return result;
}

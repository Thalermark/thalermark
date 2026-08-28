import * as Sentry from '@sentry/node';
import type { Transaction } from '@thalermark/db';
import { getLogger } from '@thalermark/logger';
import { isSearchEntityType } from '@thalermark/validation';
import { reindexEntities } from './reindex.js';
import type { SearchKey } from './types.js';

const log = getLogger(['api', 'search']);

export type SearchSession = {
  note: (entityType: string, entityId: string) => void;
  flush: () => Promise<void>;
};

// Collects the entities a request touched and reprojects them once, at the end
// of the request's transaction (TMC-198).
//
// Fed from the audit writer, so every existing audit call site becomes an
// invalidation trigger without a single route handler changing. Entity types
// that are not searchable (capital_purchase, membership, period_close, ...) are
// dropped by note(), so audit stays the general mechanism it already is.
//
// Deduped by key: a request that audits the same invoice three times (create,
// transition, email-sent) reprojects it once.
//
// THE FRESHNESS GUARANTEE, and it is deliberate (TMC-205).
//
// Reprojection happens INSIDE the mutation's transaction, so search is never
// stale: rename a customer, search a second later, and you get the new name.
// There is no catch-up window and no eventual-consistency caveat to explain to
// anyone. For a tool people use at speed, "the thing I just touched is
// findable" is worth paying for.
//
// The price was measured rather than assumed, because the obvious change is to
// move this after COMMIT and the argument for that rests entirely on the cost
// being noticeable (tests/search-write-cost.perf.test.ts, `SCALE_TEST=1`):
//
//   invoice save, 10 line items   6.7ms median, of which reprojection is 0.9ms  (~14%)
//   bulk import, 500 contacts     178ms total, of which reprojection is   3ms  (~1%)
//
// Sub-millisecond on a save, and bulk is close to free because CHUNK batches the
// whole import into one query — the case that looked like the worst is the best.
//
// So this stays in-transaction. Moving it post-commit would trade the guarantee
// above, plus a second pool checkout on every write, to save 0.9ms nobody can
// feel. Re-measure before revisiting; do not re-derive from first principles.
export function createSearchSession(tx: Transaction, accountId: string): SearchSession {
  const pending = new Map<string, SearchKey>();

  return {
    note(entityType, entityId) {
      if (!isSearchEntityType(entityType)) return;
      pending.set(`${entityType}:${entityId}`, { entityType, entityId });
    },

    async flush() {
      if (pending.size === 0) return;
      const keys = [...pending.values()];
      pending.clear();

      // SAVEPOINT, deliberately, and this is the most important line in the
      // feature.
      //
      // Catching the JS error alone would NOT be enough. A failed statement
      // poisons the whole Postgres transaction, so the subsequent COMMIT
      // silently becomes a ROLLBACK — the handler would return 200 describing
      // an invoice that was never written. drizzle's nested transaction()
      // issues SAVEPOINT / ROLLBACK TO SAVEPOINT, which contains a projector
      // fault to the index and leaves the mutation intact.
      //
      // The asymmetry justifies it: a stale search document is recoverable (the
      // weekly reindex sweep repairs it, and the next edit to that entity
      // reprojects it), while a lost invoice is not.
      try {
        await tx.transaction(async (sp) => {
          await reindexEntities(sp, accountId, keys);
        });
      } catch (err) {
        log.error('search reindex failed for {count} entities: {msg}', {
          count: keys.length,
          msg: err instanceof Error ? err.message : String(err),
        });
        Sentry.captureException(err);
      }
    },
  };
}

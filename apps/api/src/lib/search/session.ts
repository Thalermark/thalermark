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

import { type Transaction, auditEvents } from '@thalermark/db';
import { v7 as uuidv7 } from 'uuid';

export type AuditEntry = {
  entityType: string;
  entityId: string;
  action: string;
  before?: unknown;
  after?: unknown;
  companyId?: string;
};

export type AuditWriter = (entry: AuditEntry) => Promise<void>;

export type AuditWriterDeps = {
  tx: Transaction;
  accountId: string;
  actorUserId: string;
  // The actor's display name at write time, snapshotted onto the row so the
  // history survives them deleting their profile (TMC-268). Optional: the
  // background sweeps write as the system actor and have no name to give.
  actorName?: string | null;
  // Receives the entry that was just written. Callers use it both as the
  // "something was audited" signal that schedules the telemetry flush, and as
  // the invalidation key that marks an entity for search reprojection
  // (TMC-198) — which is how 40 existing audit call sites keep the search index
  // fresh without a single route handler changing.
  onWrite: (entry: AuditEntry) => void;
};

export function createAuditWriter({
  tx,
  accountId,
  actorUserId,
  actorName,
  onWrite,
}: AuditWriterDeps): AuditWriter {
  return async (entry) => {
    if (!entry.entityType || !entry.entityId || !entry.action) {
      throw new Error('audit: entityType, entityId, and action are required');
    }
    await tx.insert(auditEvents).values({
      id: uuidv7(),
      accountId,
      actorName: actorName ?? null,
      companyId: entry.companyId,
      actorUserId,
      entityType: entry.entityType,
      entityId: entry.entityId,
      action: entry.action,
      before: entry.before ?? null,
      after: entry.after ?? null,
    });
    onWrite(entry);
  };
}

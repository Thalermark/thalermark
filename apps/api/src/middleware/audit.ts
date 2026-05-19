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
  onWrite: () => void;
};

export function createAuditWriter({
  tx,
  accountId,
  actorUserId,
  onWrite,
}: AuditWriterDeps): AuditWriter {
  return async (entry) => {
    if (!entry.entityType || !entry.entityId || !entry.action) {
      throw new Error('audit: entityType, entityId, and action are required');
    }
    await tx.insert(auditEvents).values({
      id: uuidv7(),
      accountId,
      companyId: entry.companyId,
      actorUserId,
      entityType: entry.entityType,
      entityId: entry.entityId,
      action: entry.action,
      before: entry.before ?? null,
      after: entry.after ?? null,
    });
    onWrite();
  };
}

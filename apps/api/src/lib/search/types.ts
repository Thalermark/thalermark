import type { Database, Transaction } from '@thalermark/db';
import type { SearchEntityType } from '@thalermark/validation';

// A projector runs on either a tenant transaction (the request path) or a plain
// pooled connection (the public/webhook routes and the reindex sweep, which
// have no tenant tx). Both are covered because every projector filters
// account_id explicitly rather than relying on RLS — the same defense-in-depth
// rule the rest of the API follows.
export type SearchHandle = Transaction | Database;

// One row of search_documents, before normalization. The projector returns the
// human-readable text; reindexEntities normalizes it into the *_norm columns,
// so no projector can forget to.
export type SearchDocument = {
  entityType: SearchEntityType;
  entityId: string;
  companyId: string;
  // Display text, original case and accents. What the dropdown renders.
  title: string;
  subtitle: string | null;
  // Document number or reference. Indexed at weight A beside the title so
  // searching "1042" ranks the invoice top.
  ref: string | null;
  // Free text: notes, memos, concatenated line-item descriptions.
  body: string | null;
  status: string | null;
  amountCents: number | null;
  occurredOn: string | null;
  entityUpdatedAt: Date;
};

// Returns a document for every id that STILL EXISTS AND SHOULD BE INDEXED.
//
// An id absent from the result is DELETED from search_documents. That single
// rule covers hard delete, soft delete, un-archiving out of scope, and "the row
// moved to another account" with no per-entity special casing — which is also
// why an audit event only ever needs to be an invalidation key, and why the
// projector re-reads the row instead of trusting the event's before/after
// (whose shape varies from a full drizzle row to a raw request body).
export type Projector = (
  handle: SearchHandle,
  accountId: string,
  ids: string[],
) => Promise<SearchDocument[]>;

export type SearchKey = {
  entityType: SearchEntityType;
  entityId: string;
};

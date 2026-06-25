import { z } from 'zod';
import { contactCreateSchema } from './contact.js';
import { itemCreateSchema } from './item.js';

// Bulk CSV import (web only). The importer parses the CSV client-side, runs the
// column-mapping/preview UI, then posts the mapped rows as JSON to a bulk
// endpoint. Each row reuses the canonical create schema verbatim (minus
// companyId) so the server re-validates every field exactly as it would a
// single create — the importer is never a second, looser validation path.

// Bounds the request body (and the single transaction behind it). A freelancer's
// contact list / price book is tens-to-hundreds of rows; 1000 sits comfortably
// above that while keeping a sane ceiling on one import.
export const MAX_IMPORT_ROWS = 1000;

// companyId is supplied once at the top level and merged onto every row
// server-side, so the wire format can't carry rows scoped to a different company
// than the request. The whole array validates up front: one bad row fails the
// parse and the handler inserts nothing (atomic — the client preview is where
// rows get fixed).
export const contactImportSchema = z.object({
  companyId: z.string().uuid(),
  rows: z
    .array(contactCreateSchema.omit({ companyId: true }))
    .min(1)
    .max(MAX_IMPORT_ROWS),
});

export type ContactImportInput = z.infer<typeof contactImportSchema>;

// Item import rows reuse the create schema (minus companyId) plus one
// import-only field: `archived`. The create/update endpoints deliberately keep
// archived_at off their schemas (archive/restore are dedicated transitions), but
// import round-trips the catalog as it stands — an exported CSV carries each
// item's archived state, so re-import must be able to set it. Optional: an
// absent/empty cell leaves the item active. The handler maps it to archived_at.
export const itemImportRowSchema = itemCreateSchema
  .omit({ companyId: true })
  .extend({ archived: z.boolean().optional() });

export type ItemImportRowInput = z.infer<typeof itemImportRowSchema>;

export const itemImportSchema = z.object({
  companyId: z.string().uuid(),
  rows: z.array(itemImportRowSchema).min(1).max(MAX_IMPORT_ROWS),
});

export type ItemImportInput = z.infer<typeof itemImportSchema>;

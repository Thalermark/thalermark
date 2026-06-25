import { exportEntityCsv } from '$lib/export.server';
import type { RequestHandler } from './$types';

// Download the item catalog as a CSV whose columns are the import field labels
// (round-trips back through Settings → Import). Exports the FULL catalog,
// archived items included (includeArchived=true) — the export is "everything you
// have", not the default active-only list view. The archived state round-trips:
// each row carries an `archived` yes/no derived from archived_at, and the
// importer maps it back on re-import.
export const GET: RequestHandler = (event) =>
  exportEntityCsv(event, {
    entityKey: 'items',
    filename: 'items.csv',
    fetchAll: async (client, companyId) => {
      const out: Record<string, unknown>[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 25; page++) {
        const query: Record<string, string> = {
          companyId,
          limit: '200',
          includeArchived: 'true',
        };
        if (cursor) query.cursor = cursor;
        const res = await client.api.items.$get({ query });
        if (!res.ok) break;
        const body = await res.json();
        // Derive the import-shaped `archived` boolean from the stored timestamp
        // so the CSV column lines up with the import field.
        const mapped = body.items.map((it) => ({ ...it, archived: it.archivedAt != null }));
        out.push(...(mapped as Record<string, unknown>[]));
        if (!body.nextCursor) break;
        cursor = body.nextCursor;
      }
      return out;
    },
  });

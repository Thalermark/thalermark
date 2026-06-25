import { exportEntityCsv } from '$lib/export.server';
import type { RequestHandler } from './$types';

// Download the item catalog as a CSV whose columns are the import field labels
// (round-trips back through Settings → Import). Exports the FULL catalog,
// archived items included (includeArchived=true) — the export is "everything you
// have", not the default active-only list view. Note: the import schema has no
// active/archived field yet, so re-importing an archived item recreates it as
// active; carrying the archived state through both sides is a noted follow-up.
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
        out.push(...(body.items as Record<string, unknown>[]));
        if (!body.nextCursor) break;
        cursor = body.nextCursor;
      }
      return out;
    },
  });

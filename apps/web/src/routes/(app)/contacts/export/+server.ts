import { exportEntityCsv } from '$lib/export.server';
import type { RequestHandler } from './$types';

// Download every contact in the active company as a CSV whose columns are the
// import field labels — so the file round-trips back through Settings → Import.
// Visible to anyone who can view the contacts list (a read action, no cap); the
// list API already scopes to the account, so there's nothing extra to gate.
export const GET: RequestHandler = (event) =>
  exportEntityCsv(event, {
    entityKey: 'contacts',
    filename: 'contacts.csv',
    fetchAll: async (client, companyId) => {
      const out: Record<string, unknown>[] = [];
      let cursor: string | undefined;
      // Cap at 25 pages of 200, mirroring the import preview's name fetch — a
      // huge list degrades to a partial export rather than an unbounded loop.
      for (let page = 0; page < 25; page++) {
        const query: Record<string, string> = { companyId, limit: '200' };
        if (cursor) query.cursor = cursor;
        const res = await client.api.contacts.$get({ query });
        if (!res.ok) break;
        const body = await res.json();
        out.push(...(body.contacts as Record<string, unknown>[]));
        if (!body.nextCursor) break;
        cursor = body.nextCursor;
      }
      return out;
    },
  });

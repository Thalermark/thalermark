import { pickActiveCompany } from '$lib/active-company';
import { serverApiClient } from '$lib/api.server';
import { entityRowsToCsv } from '$lib/export';
import { type ImportEntityKey, entityByKey } from '$lib/import/descriptors';
import { type RequestEvent, error } from '@sveltejs/kit';

type Client = ReturnType<typeof serverApiClient>;

// Server shell behind the per-entity export endpoints. Resolves the active
// company (same pattern as the report loaders), lets the caller page the list
// API for that entity, then builds the CSV. An empty list still returns the
// header-only file so the user sees the expected columns. The list view is
// keyset-paginated, so each `fetchAll` loops the API (capped, like the import
// preview's name fetch) rather than relying on a single page.
export async function exportEntityCsv(
  event: RequestEvent,
  opts: {
    entityKey: ImportEntityKey;
    filename: string;
    fetchAll: (client: Client, companyId: string) => Promise<Record<string, unknown>[]>;
  },
): Promise<Response> {
  const client = serverApiClient(event);
  const companiesRes = await client.api.companies.$get();
  if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
  const { companies } = await companiesRes.json();
  const company = pickActiveCompany(event.cookies, companies);
  if (!company) throw error(500, 'no company in this workspace');

  const entity = entityByKey(opts.entityKey);
  const rows = await opts.fetchAll(client, company.id);
  const csv = entityRowsToCsv(entity, rows);
  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${opts.filename}"`,
    },
  });
}

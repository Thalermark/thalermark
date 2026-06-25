import { serverApiClient } from '$lib/api.server';
import { fail } from '@sveltejs/kit';
import { contactImportSchema, itemImportSchema } from '@thalermark/validation';
import type { Actions, PageServerLoad } from './$types';

type Client = ReturnType<typeof serverApiClient>;

// Pull existing names (lowercased) for the active company so the preview can
// flag rows that "may already exist". Best-effort + bounded: a freelancer's
// list is small, but the loop caps at 25 pages of 200 so a huge list degrades
// to partial detection rather than an unbounded fetch. A failed fetch just
// yields no flags (the import still works).
async function customerNames(client: Client, companyId: string): Promise<string[]> {
  const keys = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 25; page++) {
    const query: Record<string, string> = { companyId, limit: '200' };
    if (cursor) query.cursor = cursor;
    const res = await client.api.contacts.$get({ query });
    if (!res.ok) break;
    const body = await res.json();
    for (const r of body.contacts) {
      const n = r.name?.trim().toLowerCase();
      if (n) keys.add(n);
    }
    if (!body.nextCursor) break;
    cursor = body.nextCursor;
  }
  return [...keys];
}

async function itemNames(client: Client, companyId: string): Promise<string[]> {
  const keys = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 25; page++) {
    const query: Record<string, string> = { companyId, limit: '200', includeArchived: 'true' };
    if (cursor) query.cursor = cursor;
    const res = await client.api.items.$get({ query });
    if (!res.ok) break;
    const body = await res.json();
    for (const r of body.items) {
      const n = r.name?.trim().toLowerCase();
      if (n) keys.add(n);
    }
    if (!body.nextCursor) break;
    cursor = body.nextCursor;
  }
  return [...keys];
}

export const load: PageServerLoad = async (event) => {
  const { activeCompanyId } = await event.parent();
  if (!activeCompanyId) {
    return { companyId: null, existing: { contacts: [], items: [] } };
  }
  const client = serverApiClient(event);
  const [contacts, items] = await Promise.all([
    customerNames(client, activeCompanyId),
    itemNames(client, activeCompanyId),
  ]);
  return { companyId: activeCompanyId, existing: { contacts, items } };
};

export const actions: Actions = {
  // The page parses + maps + previews client-side, then posts the chosen rows
  // here as a JSON string. We re-validate with the import schema (the same one
  // the API enforces) so a bad batch fails fast with a friendly message, then
  // forward to the bulk endpoint. The API is still the authority.
  import: async (event) => {
    const form = await event.request.formData();
    const entity = String(form.get('entity') ?? '');
    const companyId = String(form.get('companyId') ?? '');

    let rows: unknown;
    try {
      rows = JSON.parse(String(form.get('rows') ?? 'null'));
    } catch {
      return fail(400, { error: 'Could not read the rows to import.' });
    }

    const client = serverApiClient(event);

    if (entity === 'contacts') {
      const parsed = contactImportSchema.safeParse({ companyId, rows });
      if (!parsed.success)
        return fail(400, { error: 'Some rows are invalid — go back and fix them.' });
      const res = await client.api.contacts.import.$post({ json: parsed.data });
      if (!res.ok) return fail(res.status, { error: await importError(res) });
      const { created } = await res.json();
      return { created, entity };
    }

    if (entity === 'items') {
      const parsed = itemImportSchema.safeParse({ companyId, rows });
      if (!parsed.success)
        return fail(400, { error: 'Some rows are invalid — go back and fix them.' });
      const res = await client.api.items.import.$post({ json: parsed.data });
      if (!res.ok) return fail(res.status, { error: await importError(res) });
      const { created } = await res.json();
      return { created, entity };
    }

    return fail(400, { error: 'Unknown import type.' });
  },
};

async function importError(res: Response): Promise<string> {
  if (res.status === 404) return 'That company is no longer available. Reload and try again.';
  if (res.status === 403) return "You don't have permission to import this.";
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  if (body?.error === 'invalid_body')
    return 'The server rejected some rows. Go back and re-check the file.';
  return `Import failed (${res.status}).`;
}

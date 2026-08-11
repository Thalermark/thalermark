import { apiErrorMessage } from '$lib/api-errors';
import { serverApiClient } from '$lib/api.server';
import { PAGE_SIZE } from '$lib/load-more';
import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

// Filters live in the URL: q (name or email) and openInvoices (contacts with
// an issued-but-unpaid invoice). Plain GET form, fresh page 1 on submit.
//
// Archived contacts are hidden by default here and everywhere else that reads
// /api/contacts (TMC-232); `?archived=1` is the management toggle, mirroring
// the items list.
export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const sp = event.url.searchParams;
  const showArchived = sp.get('archived') === '1';
  const roleParam = sp.get('role');
  const filters = {
    q: sp.get('q') ?? '',
    openInvoices: sp.get('openInvoices') === 'true',
    // Customer / vendor slice, driven by the metric-strip tiles. Unknown values
    // fall back to '' (all).
    role: roleParam === 'customer' || roleParam === 'vendor' ? roleParam : '',
  };
  // Scope to the active company within the workspace (the nav switcher's pick),
  // resolved by the (app) layout load. Without it the list spans all companies.
  const { activeCompanyId } = await event.parent();
  const query: Record<string, string> = { limit: String(PAGE_SIZE) };
  if (activeCompanyId) query.companyId = activeCompanyId;
  if (filters.q) query.q = filters.q;
  if (filters.openInvoices) query.openInvoices = 'true';
  if (filters.role) query.role = filters.role;
  if (showArchived) query.includeArchived = 'true';
  const summaryQuery: Record<string, string> = {};
  if (activeCompanyId) summaryQuery.companyId = activeCompanyId;
  const [res, summaryRes] = await Promise.all([
    client.api.contacts.$get({ query }),
    client.api.contacts.summary.$get({ query: summaryQuery }),
  ]);
  if (!res.ok) throw error(res.status, 'failed to load contacts');
  const { contacts, nextCursor } = await res.json();
  // Point-in-time roster summary for the metric strip; best-effort.
  const summary = summaryRes.ok ? await summaryRes.json() : null;
  return { contacts, nextCursor, filters, summary, showArchived };
};

// Archive / restore from the list rows. Plain HTML POST like the items list;
// the redirect keeps the current query string so a restore from the archived
// view lands back on the archived view rather than dumping the user at page 1.
async function setArchived(event: Parameters<Actions[string]>[0], archived: boolean) {
  const client = serverApiClient(event);
  const data = await event.request.formData();
  const id = String(data.get('id') ?? '');
  if (!id)
    return fail(400, {
      actionError: 'Could not tell which record that was — reload the page and try again.',
    });

  const res = archived
    ? await client.api.contacts[':id'].archive.$post({ param: { id } })
    : await client.api.contacts[':id'].restore.$post({ param: { id } });
  if (res.status === 404) throw error(404, 'contact not found');
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return fail(res.status, {
      actionError: apiErrorMessage(body?.error, 'That did not work. Try again.', body),
    });
  }
  redirect(303, `/contacts${event.url.search}`);
}

export const actions: Actions = {
  archive: (event) => setArchived(event, true),
  restore: (event) => setArchived(event, false),
};

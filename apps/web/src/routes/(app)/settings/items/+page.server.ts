import { serverApiClient } from '$lib/api.server';
import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

// The management list. Archived items are hidden by default (mirrors the
// picker, which never offers them); `?archived=1` flips the show-archived
// toggle and re-fetches with includeArchived=true so the archived rows appear
// alongside the live ones.
export const load: PageServerLoad = async (event) => {
  const showArchived = event.url.searchParams.get('archived') === '1';
  const client = serverApiClient(event);
  const res = await client.api.items.$get({
    query: showArchived ? { includeArchived: 'true' } : {},
  });
  if (!res.ok) throw error(res.status, 'failed to load items');
  const { items } = await res.json();
  return { items, showArchived };
};

// Archive / restore from the list rows. Plain HTML POST (no use:enhance, like
// the rest of the app); the redirect keeps the current toggle state so a
// restore from the archived view lands back on the archived view.
async function setArchived(event: Parameters<Actions[string]>[0], archived: boolean) {
  const client = serverApiClient(event);
  const data = await event.request.formData();
  const id = String(data.get('id') ?? '');
  if (!id) return fail(400, { actionError: 'missing_id' });

  const res = archived
    ? await client.api.items[':id'].archive.$post({ param: { id } })
    : await client.api.items[':id'].restore.$post({ param: { id } });
  if (res.status === 404) throw error(404, 'item not found');
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return fail(res.status, { actionError: body?.error ?? 'action_failed' });
  }
  redirect(303, `/settings/items${event.url.search}`);
}

export const actions: Actions = {
  archive: (event) => setArchived(event, true),
  restore: (event) => setArchived(event, false),
};

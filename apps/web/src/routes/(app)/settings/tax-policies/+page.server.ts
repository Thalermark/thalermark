import { serverApiClient } from '$lib/api.server';
import { PAGE_SIZE } from '$lib/load-more';
import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

// The management list. Archived policies are hidden by default (mirrors the
// item / line picker, which never offers them); `?archived=1` flips the
// show-archived toggle and re-fetches with includeArchived=true. Mirrors
// /items.
export const load: PageServerLoad = async (event) => {
  const showArchived = event.url.searchParams.get('archived') === '1';
  const client = serverApiClient(event);
  const { activeCompanyId } = await event.parent();
  const query: Record<string, string> = { limit: String(PAGE_SIZE) };
  if (activeCompanyId) query.companyId = activeCompanyId;
  if (showArchived) query.includeArchived = 'true';
  const res = await client.api['tax-policies'].$get({ query });
  if (!res.ok) throw error(res.status, 'failed to load tax policies');
  const { taxPolicies, nextCursor } = await res.json();
  return { taxPolicies, showArchived, nextCursor };
};

async function setArchived(event: Parameters<Actions[string]>[0], archived: boolean) {
  const client = serverApiClient(event);
  const data = await event.request.formData();
  const id = String(data.get('id') ?? '');
  if (!id) return fail(400, { actionError: 'missing_id' });

  const res = archived
    ? await client.api['tax-policies'][':id'].archive.$post({ param: { id } })
    : await client.api['tax-policies'][':id'].restore.$post({ param: { id } });
  if (res.status === 404) throw error(404, 'tax policy not found');
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return fail(res.status, { actionError: body?.error ?? 'action_failed' });
  }
  redirect(303, `/settings/tax-policies${event.url.search}`);
}

export const actions: Actions = {
  archive: (event) => setArchived(event, true),
  restore: (event) => setArchived(event, false),
};

import { pickActiveCompany } from '$lib/active-company';
import { apiErrorMessage } from '$lib/api-errors';
import { serverApiClient } from '$lib/api.server';
import { PAGE_SIZE } from '$lib/load-more';
import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { mapOwnerMoneyRows } from './owner-money-rows';

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);

  // The active company within this workspace (cookie-backed switcher), same as
  // the expense/bill lists; every list is scoped to it.
  const companiesRes = await client.api.companies.$get();
  if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
  const { companies } = await companiesRes.json();
  const company = pickActiveCompany(event.cookies, companies);
  if (!company) throw error(500, 'no company in this workspace');

  // 'contribution' | 'draw' | '' (all). Only forward when set.
  const kind = event.url.searchParams.get('kind') ?? '';
  // The show-deleted view (TMC-240) — see the expenses list for the rationale.
  const showDeleted = event.url.searchParams.get('deleted') === '1';

  const query: Record<string, string> = { companyId: company.id, limit: String(PAGE_SIZE) };
  if (kind) query.kind = kind;
  if (showDeleted) query.includeDeleted = 'true';

  const res = await client.api['owner-money'].$get({ query });
  if (!res.ok) throw error(res.status, 'failed to load owner money');
  const { events, nextCursor } = await res.json();

  // The starting-balances fetch that used to feed a summary card here is gone
  // with the card — that's setup, and it lives in Settings now. It also always
  // showed the simple shape's cash figure, so a company that had entered a full
  // trial balance saw one number standing in for a dozen.

  return {
    rows: mapOwnerMoneyRows(events),
    nextCursor,
    companyId: company.id,
    filters: { kind },
    showDeleted,
  };
};

export const actions: Actions = {
  // Restore from the show-deleted view — the same shape as the expenses list.
  restore: async (event) => {
    const client = serverApiClient(event);
    const data = await event.request.formData();
    const id = String(data.get('id') ?? '');
    if (!id)
      return fail(400, {
        restoreError: 'Could not tell which record to restore — reload the page and try again.',
      });

    const res = await client.api['owner-money'][':id'].restore.$post({ param: { id } });
    if (res.status === 404) throw error(404, 'not found');
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        restoreError: apiErrorMessage(body?.error, 'restore_failed', body),
      });
    }
    redirect(303, `/owner-money${event.url.search}`);
  },
};

import { pickActiveCompany } from '$lib/active-company';
import { apiErrorMessage } from '$lib/api-errors';
import { serverApiClient } from '$lib/api.server';
import { PAGE_SIZE } from '$lib/load-more';
import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { mapPurchaseRows } from './purchase-rows';

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);

  const companiesRes = await client.api.companies.$get();
  if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
  const { companies } = await companiesRes.json();
  const company = pickActiveCompany(event.cookies, companies);
  if (!company) throw error(500, 'no company in this workspace');

  // The show-deleted view (TMC-240) — see the expenses list for the rationale.
  const showDeleted = event.url.searchParams.get('deleted') === '1';
  const query: Record<string, string> = { companyId: company.id, limit: String(PAGE_SIZE) };
  if (showDeleted) query.includeDeleted = 'true';

  const res = await client.api.purchases.$get({ query });
  if (!res.ok) throw error(res.status, 'failed to load purchases');
  const { purchases, nextCursor } = await res.json();

  return { rows: mapPurchaseRows(purchases), nextCursor, companyId: company.id, showDeleted };
};

export const actions: Actions = {
  // Restore from the show-deleted view — the same shape as the expenses list.
  // This one also puts back every year of depreciation the delete reversed.
  restore: async (event) => {
    const client = serverApiClient(event);
    const data = await event.request.formData();
    const id = String(data.get('id') ?? '');
    if (!id)
      return fail(400, {
        restoreError: 'Could not tell which record to restore — reload the page and try again.',
      });

    const res = await client.api.purchases[':id'].restore.$post({ param: { id } });
    if (res.status === 404) throw error(404, 'purchase not found');
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        restoreError: apiErrorMessage(body?.error, 'That could not be restored. Try again.', body),
      });
    }
    redirect(303, `/purchases${event.url.search}`);
  },
};

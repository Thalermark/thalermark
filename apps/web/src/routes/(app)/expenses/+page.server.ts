import { pickActiveCompany } from '$lib/active-company';
import { apiErrorMessage } from '$lib/api-errors';
import { serverApiClient } from '$lib/api.server';
import { PAGE_SIZE } from '$lib/load-more';
import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { mapExpenseRows } from './expense-rows';

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);

  // The active company within this workspace (cookie-backed switcher), same as
  // the invoice/estimate forms; every list/filter is scoped to it. Falls back
  // to the first company for single-company accounts.
  const companiesRes = await client.api.companies.$get();
  if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
  const { companies } = await companiesRes.json();
  const company = pickActiveCompany(event.cookies, companies);
  if (!company) throw error(500, 'no company in this workspace');

  const params = event.url.searchParams;
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const category = params.get('category') ?? '';
  const q = params.get('q') ?? '';
  const needsReview = params.get('needsReview') === 'true';
  // The show-deleted view (TMC-240). Deleted expenses are hidden by default;
  // `?deleted=1` brings them back into the list so they can be restored, which
  // is the only place in the app they are reachable from.
  const showDeleted = params.get('deleted') === '1';

  // Only forward filters that are set — an empty `from`/`to` would fail the
  // API's date-shape check, and empty `q` would match nothing useful.
  const query: Record<string, string> = { companyId: company.id, limit: String(PAGE_SIZE) };
  if (from) query.from = from;
  if (to) query.to = to;
  if (category) query.categoryAccountId = category;
  if (q) query.q = q;
  if (needsReview) query.needsReview = 'true';
  if (showDeleted) query.includeDeleted = 'true';

  const [expensesRes, accountsRes] = await Promise.all([
    client.api.expenses.$get({ query }),
    client.api.companies[':id'].accounts.$get({
      param: { id: company.id },
      query: { type: 'expense' },
    }),
  ]);
  if (!expensesRes.ok) throw error(expensesRes.status, 'failed to load expenses');
  if (!accountsRes.ok) throw error(accountsRes.status, 'failed to load categories');

  const { expenses, nextCursor } = await expensesRes.json();
  const { accounts } = await accountsRes.json();
  const categoryNameById = new Map(accounts.map((a) => [a.id, `${a.code} · ${a.name}`]));

  return {
    rows: mapExpenseRows(expenses, categoryNameById),
    nextCursor,
    companyId: company.id,
    categories: accounts.map((a) => ({ id: a.id, label: `${a.code} · ${a.name}` })),
    filters: { from, to, category, q, needsReview },
    showDeleted,
  };
};

export const actions: Actions = {
  // Restore from the show-deleted view. Plain HTML POST like the items archive
  // pair; the redirect keeps `?deleted=1` so the user stays where they were and
  // can see the row they just brought back.
  restore: async (event) => {
    const client = serverApiClient(event);
    const data = await event.request.formData();
    const id = String(data.get('id') ?? '');
    if (!id)
      return fail(400, {
        restoreError: 'Could not tell which record to restore — reload the page and try again.',
      });

    const res = await client.api.expenses[':id'].restore.$post({ param: { id } });
    if (res.status === 404) throw error(404, 'expense not found');
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        restoreError: apiErrorMessage(body?.error, 'restore_failed', body),
      });
    }
    redirect(303, `/expenses${event.url.search}`);
  },
};

import { serverApiClient } from '$lib/api.server';
import { PAGE_SIZE } from '$lib/load-more';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { mapExpenseRows } from './expense-rows';

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);

  // Single-company assumption, same as the invoice/estimate forms: the active
  // company is companies[0]. A company switcher lands when multi-company UI
  // does; until then every list/filter is scoped to this one.
  const companiesRes = await client.api.companies.$get();
  if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
  const { companies } = await companiesRes.json();
  const company = companies[0];
  if (!company) throw error(500, 'no company on this account');

  const params = event.url.searchParams;
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const category = params.get('category') ?? '';
  const q = params.get('q') ?? '';

  // Only forward filters that are set — an empty `from`/`to` would fail the
  // API's date-shape check, and empty `q` would match nothing useful.
  const query: Record<string, string> = { companyId: company.id, limit: String(PAGE_SIZE) };
  if (from) query.from = from;
  if (to) query.to = to;
  if (category) query.categoryAccountId = category;
  if (q) query.q = q;

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
    filters: { from, to, category, q },
  };
};

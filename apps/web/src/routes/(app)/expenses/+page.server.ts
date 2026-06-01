import { serverApiClient } from '$lib/api.server';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Page-number pagination is done SSR-side: the API returns the full filtered
// set (the same load-all shape the invoice/estimate lists use) and load()
// slices the current page out of it. Page size is a UI concern, kept here.
const PAGE_SIZE = 25;

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
  const pageRaw = Number.parseInt(params.get('page') ?? '1', 10);
  const requestedPage = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;

  // Only forward filters that are set — an empty `from`/`to` would fail the
  // API's date-shape check, and empty `q` would match nothing useful.
  const query: Record<string, string> = { companyId: company.id };
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

  const { expenses } = await expensesRes.json();
  const { accounts } = await accountsRes.json();
  const categoryNameById = new Map(accounts.map((a) => [a.id, `${a.code} · ${a.name}`]));

  const total = expenses.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(requestedPage, pageCount);
  const start = (page - 1) * PAGE_SIZE;
  const rows = expenses.slice(start, start + PAGE_SIZE).map((e) => ({
    id: e.id,
    expenseDate: e.expenseDate,
    merchant: e.merchant,
    amount: e.amount,
    categoryName: categoryNameById.get(e.categoryAccountId) ?? '—',
    hasReceipt: e.receiptStorageKey != null,
  }));

  return {
    rows,
    categories: accounts.map((a) => ({ id: a.id, label: `${a.code} · ${a.name}` })),
    filters: { from, to, category, q },
    pagination: { page, pageCount, total, pageSize: PAGE_SIZE },
  };
};

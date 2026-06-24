import { serverApiClient } from '$lib/api.server';
import { PAGE_SIZE } from '$lib/load-more';
import { json } from '@sveltejs/kit';
import { mapExpenseRows } from '../expense-rows';
import type { RequestHandler } from './$types';

// "Load more" proxy for the expenses list. Must reproduce page 1's filter set
// (companyId + from/to/category/q) so the cursor walks the same result set.
// Fetches the (small, bounded) category set to label rows like the loader.
export const GET: RequestHandler = async (event) => {
  const p = event.url.searchParams;
  const companyId = p.get('companyId') ?? '';
  if (!companyId) return json({ rows: [], nextCursor: null }, { status: 400 });
  const cursor = p.get('cursor') ?? undefined;

  const client = serverApiClient(event);
  const query: Record<string, string> = { companyId, limit: String(PAGE_SIZE) };
  if (cursor) query.cursor = cursor;
  const from = p.get('from');
  const to = p.get('to');
  const category = p.get('category');
  const q = p.get('q');
  if (from) query.from = from;
  if (to) query.to = to;
  if (category) query.categoryAccountId = category;
  if (q) query.q = q;
  if (p.get('needsReview') === 'true') query.needsReview = 'true';

  const [expensesRes, accountsRes] = await Promise.all([
    client.api.expenses.$get({ query }),
    client.api.companies[':id'].accounts.$get({
      param: { id: companyId },
      query: { type: 'expense' },
    }),
  ]);
  if (!expensesRes.ok) return json({ rows: [], nextCursor: null }, { status: expensesRes.status });
  const { expenses, nextCursor } = await expensesRes.json();
  const categoryNameById = accountsRes.ok
    ? new Map((await accountsRes.json()).accounts.map((a) => [a.id, `${a.code} · ${a.name}`]))
    : new Map<string, string>();

  return json({ rows: mapExpenseRows(expenses, categoryNameById), nextCursor });
};

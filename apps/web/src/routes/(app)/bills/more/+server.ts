import { serverApiClient } from '$lib/api.server';
import { PAGE_SIZE } from '$lib/load-more';
import { json } from '@sveltejs/kit';
import { mapBillRows } from '../bill-rows';
import type { RequestHandler } from './$types';

// "Load more" proxy for the bills list. Reproduces page 1's filter set
// (companyId + status) so the cursor walks the same result set, and fetches the
// (small, bounded) expense-category set to label rows like the loader.
export const GET: RequestHandler = async (event) => {
  const p = event.url.searchParams;
  const companyId = p.get('companyId') ?? '';
  if (!companyId) return json({ rows: [], nextCursor: null }, { status: 400 });
  const cursor = p.get('cursor') ?? undefined;

  const client = serverApiClient(event);
  const query: Record<string, string> = { companyId, limit: String(PAGE_SIZE) };
  if (cursor) query.cursor = cursor;
  const status = p.get('status');
  if (status) query.status = status;

  const [billsRes, accountsRes] = await Promise.all([
    client.api.bills.$get({ query }),
    client.api.companies[':id'].accounts.$get({
      param: { id: companyId },
      query: { type: 'expense' },
    }),
  ]);
  if (!billsRes.ok) return json({ rows: [], nextCursor: null }, { status: billsRes.status });
  const { bills, nextCursor } = await billsRes.json();
  const categoryNameById = accountsRes.ok
    ? new Map((await accountsRes.json()).accounts.map((a) => [a.id, `${a.code} · ${a.name}`]))
    : new Map<string, string>();

  return json({ rows: mapBillRows(bills, categoryNameById), nextCursor });
};

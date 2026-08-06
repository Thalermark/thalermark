import { cookieCompanyId } from '$lib/active-company';
import { serverApiClient } from '$lib/api.server';
import { PAGE_SIZE } from '$lib/load-more';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// "Load more" proxy for the jobs list. Carries the closed toggle so an appended
// page matches the current view.
export const GET: RequestHandler = async (event) => {
  const cursor = event.url.searchParams.get('cursor') ?? undefined;
  const showClosed = event.url.searchParams.get('closed') === '1';
  const client = serverApiClient(event);
  const query: Record<string, string> = { limit: String(PAGE_SIZE) };
  const companyId = cookieCompanyId(event.cookies);
  if (companyId) query.companyId = companyId;
  if (cursor) query.cursor = cursor;
  if (!showClosed) query.status = 'open';
  const res = await client.api.jobs.$get({ query });
  if (!res.ok) return json({ rows: [], nextCursor: null }, { status: res.status });
  const { jobs, nextCursor } = await res.json();
  return json({ rows: jobs, nextCursor });
};

import { serverApiClient } from '$lib/api.server';
import { PAGE_SIZE } from '$lib/load-more';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// The jobs list. Open jobs only by default — a closed job is filed away, and
// the point of closing one is that it stops cluttering the places you pick from.
// `?closed=1` flips the toggle, mirroring the archived toggle on /items.
export const load: PageServerLoad = async (event) => {
  const showClosed = event.url.searchParams.get('closed') === '1';
  const client = serverApiClient(event);
  const { activeCompanyId } = await event.parent();
  const query: Record<string, string> = { limit: String(PAGE_SIZE) };
  if (activeCompanyId) query.companyId = activeCompanyId;
  if (!showClosed) query.status = 'open';
  const res = await client.api.jobs.$get({ query });
  if (!res.ok) throw error(res.status, 'failed to load jobs');
  const { jobs, nextCursor } = await res.json();
  return { jobs, showClosed, nextCursor };
};

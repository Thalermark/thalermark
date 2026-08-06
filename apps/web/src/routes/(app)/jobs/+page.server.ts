import { serverApiClient } from '$lib/api.server';
import { PAGE_SIZE } from '$lib/load-more';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// The jobs list. Open jobs only by default — a closed job is filed away, and
// the point of closing one is that it stops cluttering the places you pick from.
// `?closed=1` flips the toggle, mirroring the archived toggle on /items.
export const load: PageServerLoad = async (event) => {
  // Filters live in the URL so they are shareable and survive the back button —
  // same plain-GET approach as /invoices.
  const params = event.url.searchParams;
  const status = params.get('status') ?? 'open';
  const q = (params.get('q') ?? '').trim();

  const client = serverApiClient(event);
  const { activeCompanyId } = await event.parent();
  const query: Record<string, string> = { limit: String(PAGE_SIZE) };
  if (activeCompanyId) query.companyId = activeCompanyId;
  if (status === 'open' || status === 'closed') query.status = status;
  if (q) query.q = q;

  const [res, summaryRes] = await Promise.all([
    client.api.jobs.$get({ query }),
    client.api.jobs.summary.$get({
      query: activeCompanyId ? { companyId: activeCompanyId } : {},
    }),
  ]);
  if (!res.ok) throw error(res.status, 'failed to load jobs');
  const { jobs, nextCursor } = await res.json();
  // Best-effort: a failed summary hides the tiles rather than failing the page.
  const summary = summaryRes.ok ? await summaryRes.json() : null;

  return { jobs, nextCursor, summary, filters: { status, q } };
};

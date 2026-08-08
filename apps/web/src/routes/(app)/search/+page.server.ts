import { serverApiClient } from '$lib/api.server';
import { error } from '@sveltejs/kit';
import { SEARCH_MAX_DEPTH } from '@thalermark/validation';
import type { PageServerLoad } from './$types';

// The full results page (TMC-198). The header dropdown shows top hits; this is
// where Enter lands, and where someone goes when the dropdown's three-per-type
// cap is hiding what they want.
//
// State lives in the URL (q, scope, page) so a result set is linkable and the
// back button works — same posture as the list pages' filter bars.
const PAGE_SIZE = 25;

export const load: PageServerLoad = async (event) => {
  const sp = event.url.searchParams;
  const q = sp.get('q')?.trim() ?? '';
  // Scope toggle: by default search the business you're working in, because
  // that's what the rest of the app scopes to. 'all' spans every company in the
  // workspace, which is the whole point of having several.
  const scope = sp.get('scope') === 'all' ? 'all' : 'company';
  const pageNum = Math.max(1, Number.parseInt(sp.get('page') ?? '1', 10) || 1);
  const offset = (pageNum - 1) * PAGE_SIZE;

  const empty = {
    q,
    scope,
    page: pageNum,
    pageSize: PAGE_SIZE,
    results: [],
    hasMore: false,
    atDepthLimit: false,
  };
  if (q === '') return empty;

  // Past the ranked-set ceiling there is nothing more to page through — the
  // per-entity lists are the right tool from there, and the page says so.
  if (offset >= SEARCH_MAX_DEPTH) return { ...empty, atDepthLimit: true };

  const { activeCompanyId } = await event.parent();
  const query: Record<string, string> = {
    q,
    limit: String(PAGE_SIZE),
    offset: String(offset),
  };
  if (scope !== 'all' && activeCompanyId) query.companyId = activeCompanyId;

  const res = await serverApiClient(event).api.search.$get({ query });
  // Unlike the type-ahead proxy, a failure here is surfaced: this page is a
  // destination, and silently rendering "nothing matched" for a broken search
  // would be a lie.
  if (!res.ok) throw error(res.status, 'search failed');
  const body = await res.json();

  return {
    q,
    scope,
    page: pageNum,
    pageSize: PAGE_SIZE,
    results: body.results,
    hasMore: body.hasMore,
    atDepthLimit: offset + PAGE_SIZE >= SEARCH_MAX_DEPTH && body.hasMore,
  };
};

// Shared "Load more" client helper for keyset-paginated list pages.
//
// Each list route renders page 1 server-side (its +page.server.ts forwards
// ?limit= and returns { <rows>, nextCursor }) and exposes a same-origin
// `<route>/more` proxy (+server.ts) that forwards the cursor to the API and
// returns a uniform { rows, nextCursor }. The page component holds rows +
// cursor in $state and calls fetchMore() to append the next page.
//
// PAGE_SIZE is the per-request count both the loader and the proxy pass as
// ?limit=. Kept here so the two stay in lockstep.
export const PAGE_SIZE = 25;

export type Page<T> = { rows: T[]; nextCursor: string | null };

// Fetch the next page from a route's `/more` proxy. `path` is the proxy URL
// (e.g. '/customers/more'); `params` carries the cursor plus any active
// filters the proxy needs to reproduce the current result set.
export async function fetchMore<T>(
  path: string,
  cursor: string,
  params: Record<string, string> = {},
): Promise<Page<T>> {
  const url = new URL(path, location.origin);
  url.searchParams.set('cursor', cursor);
  for (const [k, v] of Object.entries(params)) {
    if (v) url.searchParams.set(k, v);
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`load more failed: ${res.status}`);
  return res.json();
}

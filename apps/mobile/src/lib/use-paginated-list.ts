import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';

// Keyset infinite-scroll for the mobile list screens. Mirrors the web "Load
// more" contract (#194/#195): page 1 loads on focus, onEndReached pulls the
// next page by cursor and appends. The screen supplies a `fetchPage(cursor)`
// that returns the already-mapped rows + nextCursor (or null on failure).
//
// Footgun handled here so every screen doesn't re-derive it: an in-flight
// `busyRef` (a ref, NOT state-in-deps) gates re-entry so a fast scroll can't
// fire overlapping loadMore() calls or stomp the focus refetch (the M3
// once-only-bootstrap caution applies to any multi-fetch flow).

export const PAGE_SIZE = 25;

// Build the ?limit=&cursor= query for a page request (cursor omitted for page 1).
export function pageQuery(cursor: string | null): Record<string, string> {
  const q: Record<string, string> = { limit: String(PAGE_SIZE) };
  if (cursor) q.cursor = cursor;
  return q;
}

export type Page<T> = { rows: T[]; nextCursor: string | null };
export type ListState<T> =
  | { state: 'loading' }
  | { state: 'ready'; rows: T[] }
  | { state: 'error' };

export function usePaginatedList<T>(fetchPage: (cursor: string | null) => Promise<Page<T> | null>) {
  const [list, setList] = useState<ListState<T>>({ state: 'loading' });
  const [loadingMore, setLoadingMore] = useState(false);
  // hasMore mirrors cursorRef as state so a "Load more" button (activity feed)
  // can react to it; the FlatList screens just rely on onEndReached + loadMore's
  // no-op guard and ignore it.
  const [hasMore, setHasMore] = useState(false);
  const cursorRef = useRef<string | null>(null);
  const busyRef = useRef(false);

  const loadFirst = useCallback(
    (active: () => boolean) => {
      busyRef.current = true;
      fetchPage(null)
        .then((page) => {
          if (!active()) return;
          if (!page) {
            setList({ state: 'error' });
            return;
          }
          cursorRef.current = page.nextCursor;
          setHasMore(page.nextCursor !== null);
          setList({ state: 'ready', rows: page.rows });
        })
        .catch(() => {
          if (active()) setList({ state: 'error' });
        })
        .finally(() => {
          busyRef.current = false;
        });
    },
    [fetchPage],
  );

  // Page 1 on focus (so a row created/edited on a child screen shows on
  // return) and whenever fetchPage changes (e.g. a filter/toggle flips). The
  // list isn't reset to 'loading' here — the prior rows stay until the refetch
  // replaces them, matching the screens' existing silent-refresh behavior.
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      loadFirst(() => alive);
      return () => {
        alive = false;
      };
    }, [loadFirst]),
  );

  const loadMore = useCallback(() => {
    if (busyRef.current || cursorRef.current === null) return;
    busyRef.current = true;
    setLoadingMore(true);
    fetchPage(cursorRef.current)
      .then((page) => {
        if (!page) return;
        cursorRef.current = page.nextCursor;
        setHasMore(page.nextCursor !== null);
        setList((prev) =>
          prev.state === 'ready' ? { state: 'ready', rows: [...prev.rows, ...page.rows] } : prev,
        );
      })
      .catch(() => {
        // Keep what we have; the next onEndReached or a focus refetch retries.
      })
      .finally(() => {
        busyRef.current = false;
        setLoadingMore(false);
      });
  }, [fetchPage]);

  // Imperative page-1 reload for in-screen mutations (e.g. item archive/restore).
  const reload = useCallback(() => loadFirst(() => true), [loadFirst]);

  return { list, loadingMore, loadMore, reload, hasMore };
}

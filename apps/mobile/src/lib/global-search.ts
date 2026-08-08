import {
  SEARCH_MIN_TEXT_CHARS,
  type SearchEntityType,
  type SearchResult,
} from '@thalermark/validation';
import { useEffect, useRef, useState } from 'react';
import { api } from './api';

// Client half of global search on mobile (TMC-198). Same debounce/abort idiom as
// ContactFilterField, calling GET /api/search directly — mobile has no BFF, so
// there is no proxy layer to mirror the web's /search/suggest.

const DEBOUNCE_MS = 180;

// The six entity types mobile can actually navigate to. `item` is deliberately
// absent: there is no items screen in the mobile app, so offering an item hit
// would be a dead end. Sent as ?types= so the server never ranks one into the
// results rather than filtering it out client-side and leaving a short page.
export const MOBILE_SEARCH_TYPES: SearchEntityType[] = [
  'invoice',
  'estimate',
  'contact',
  'expense',
  'bill',
  'job',
];

const NUMERIC_RE = /^\$?\s*[\d.,]+$/;

// Mirrors the server's rule: text needs three characters, but a numeric query
// matches amounts and document numbers by equality and is worth sending at any
// length. The two must agree, or the box goes quiet on queries the API would
// have answered.
export function isWorthSearching(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed === '') return false;
  if (NUMERIC_RE.test(trimmed)) return true;
  return trimmed.length >= SEARCH_MIN_TEXT_CHARS;
}

export function useGlobalSearch(companyId: string | null) {
  const [text, setText] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
      abort.current?.abort();
    };
  }, []);

  function onChangeText(next: string) {
    setText(next);
    if (timer.current) clearTimeout(timer.current);
    if (!isWorthSearching(next)) {
      abort.current?.abort();
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    timer.current = setTimeout(() => run(next.trim()), DEBOUNCE_MS);
  }

  async function run(q: string) {
    abort.current?.abort();
    abort.current = new AbortController();
    try {
      const query: Record<string, string> = {
        q,
        limit: '50',
        types: MOBILE_SEARCH_TYPES.join(','),
      };
      if (companyId) query.companyId = companyId;
      const res = await api.api.search.$get({ query }, { init: { signal: abort.current.signal } });
      if (!res.ok) {
        setResults([]);
        setLoading(false);
        return;
      }
      const body = await res.json();
      setResults(body.results as SearchResult[]);
      setLoading(false);
    } catch (err) {
      // An abort means a newer keystroke took over; leave state alone so the
      // stale request doesn't clear the newer one's spinner.
      if ((err as { name?: string }).name === 'AbortError') return;
      setResults([]);
      setLoading(false);
    }
  }

  return { text, onChangeText, results, loading, searching: isWorthSearching(text) };
}

// Duplicated from web rather than shared: the route strings genuinely differ
// between the two apps, so a shared map would be a false abstraction that has
// to be conditioned on platform anyway.
export function hrefFor(entityType: SearchEntityType, id: string): string | null {
  switch (entityType) {
    case 'invoice':
      return `/invoices/${id}`;
    case 'estimate':
      return `/estimates/${id}`;
    case 'contact':
      return `/contacts/${id}`;
    case 'expense':
      return `/expenses/${id}`;
    case 'bill':
      return `/bills/${id}`;
    case 'job':
      return `/jobs/${id}`;
    // No items screen on mobile. Filtered out of the query above, so this is
    // only reachable if someone adds 'item' to MOBILE_SEARCH_TYPES without
    // adding the screen.
    case 'item':
      return null;
  }
}

const LABELS: Record<SearchEntityType, string> = {
  invoice: 'Invoices',
  estimate: 'Estimates',
  contact: 'Contacts',
  expense: 'Expenses',
  bill: 'Bills',
  job: 'Jobs',
  item: 'Items',
};

// Grouped in rank order — a type's section appears where its best hit ranked,
// so the strongest match is always in the first section.
export function groupByType(
  results: SearchResult[],
): { type: SearchEntityType; label: string; items: SearchResult[] }[] {
  const groups = new Map<SearchEntityType, SearchResult[]>();
  for (const r of results) {
    const list = groups.get(r.entityType);
    if (list) list.push(r);
    else groups.set(r.entityType, [r]);
  }
  return [...groups.entries()].map(([type, items]) => ({ type, label: LABELS[type], items }));
}

export function formatMoney(amount: string): string {
  return Number(amount).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

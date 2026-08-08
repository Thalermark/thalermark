import {
  SEARCH_ENTITY_TYPES,
  SEARCH_MIN_TEXT_CHARS,
  type SearchEntityType,
  type SearchResult,
} from '@thalermark/validation';

// Client half of global search (TMC-198). Same shape as $lib/contact-search:
// one debounce timer, one AbortController, results handed back through a
// callback. The differences are the endpoint and the minimum query length.

// Slightly tighter than the pickers' 200ms. This box is the first thing typed
// on a page rather than a field mid-form, so it wants to feel immediate; the
// server-side rate limit (120/min) is the actual backstop.
const DEBOUNCE_MS = 180;

// A numeric query searches amounts and document numbers by equality rather than
// by scanning text, so it is worth sending below the text floor. Mirrors the
// same exemption on the server — the two must agree or the box goes quiet on
// exactly the queries the API would have answered.
const NUMERIC_RE = /^\$?\s*[\d.,]+$/;

export function isWorthSearching(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed === '') return false;
  if (NUMERIC_RE.test(trimmed)) return true;
  return trimmed.length >= SEARCH_MIN_TEXT_CHARS;
}

export type GlobalSearchState = {
  results: SearchResult[];
  loading: boolean;
};

export function createGlobalSearch(onState: (state: GlobalSearchState) => void) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let abort: AbortController | null = null;

  function schedule(raw: string) {
    if (timer) clearTimeout(timer);
    if (!isWorthSearching(raw)) {
      abort?.abort();
      onState({ results: [], loading: false });
      return;
    }
    // Loading is set at SCHEDULE time, not at fetch time, so the box says
    // "searching" through the debounce window rather than looking idle for
    // 180ms and then flashing.
    onState({ results: [], loading: true });
    timer = setTimeout(() => run(raw.trim()), DEBOUNCE_MS);
  }

  async function run(q: string) {
    abort?.abort();
    abort = new AbortController();
    try {
      const res = await fetch(`/search/suggest?q=${encodeURIComponent(q)}`, {
        signal: abort.signal,
      });
      if (!res.ok) {
        onState({ results: [], loading: false });
        return;
      }
      const body = (await res.json()) as { results: SearchResult[] };
      onState({ results: body.results, loading: false });
    } catch (err) {
      // An abort means a newer keystroke already took over — leave the state
      // alone so the in-flight request doesn't clear the newer one's spinner.
      if ((err as { name?: string }).name === 'AbortError') return;
      onState({ results: [], loading: false });
    }
  }

  function destroy() {
    if (timer) clearTimeout(timer);
    abort?.abort();
  }

  return { schedule, destroy };
}

// Where a hit goes. Owned by the client rather than returned by the API,
// because web and mobile route strings genuinely differ and baking a URL into
// the response would cost a migration to undo.
export function hrefFor(entityType: SearchEntityType, id: string): string {
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
    case 'item':
      return `/items/${id}`;
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

export function labelFor(entityType: SearchEntityType): string {
  return LABELS[entityType];
}

// Money arrives as a decimal string and has to be readable at a glance in a
// list of mixed entity types. Same shape the dashboard headline uses — a
// freelancer's amounts are nowhere near float-precision range, so
// toLocaleString is safe here.
export function formatMoney(amount: string): string {
  return Number(amount).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

// Groups results for display while preserving rank order: a type's section
// appears where its best hit ranked, so the strongest match is always in the
// first group rather than wherever a fixed entity order happened to put it.
export function groupByType(
  results: SearchResult[],
): { type: SearchEntityType; label: string; items: SearchResult[] }[] {
  const groups = new Map<SearchEntityType, SearchResult[]>();
  for (const r of results) {
    const list = groups.get(r.entityType);
    if (list) list.push(r);
    else groups.set(r.entityType, [r]);
  }
  return [...groups.entries()]
    .filter(([type]) => SEARCH_ENTITY_TYPES.includes(type))
    .map(([type, items]) => ({ type, label: LABELS[type], items }));
}

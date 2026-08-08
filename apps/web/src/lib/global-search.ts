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

// THE ORDER SECTIONS APPEAR IN. Change this array to reorder them.
//
// Fixed, deliberately. The first version ordered groups by whichever type's
// best hit scored highest, which sounded right and was wrong in practice: the
// dropdown's shape moved between queries (invoices above jobs for one term,
// below it for the next), so there was nothing to build muscle memory against.
// A predictable layout beats a marginally better-ordered one when the whole
// point is to find something fast.
//
// Contacts lead because a person's name is the most common thing typed into a
// search box, and a contact is the hub you navigate onward from. Then the sales
// documents, then money-out, then the supporting entities.
export const SEARCH_GROUP_ORDER: SearchEntityType[] = [
  'contact',
  'invoice',
  'estimate',
  'expense',
  'bill',
  'job',
  'item',
];

// Groups results for display in SEARCH_GROUP_ORDER. Rank order is preserved
// WITHIN each group, and empty groups are omitted entirely.
export function groupByType(
  results: SearchResult[],
): { type: SearchEntityType; label: string; items: SearchResult[] }[] {
  const groups = new Map<SearchEntityType, SearchResult[]>();
  for (const r of results) {
    const list = groups.get(r.entityType);
    if (list) list.push(r);
    else groups.set(r.entityType, [r]);
  }
  return SEARCH_GROUP_ORDER.filter((type) => groups.has(type)).map((type) => ({
    type,
    label: LABELS[type],
    items: groups.get(type) as SearchResult[],
  }));
}

// Where the best-scoring result lands once the groups are laid out.
//
// Needed because the two orders have come apart: the API returns results ranked
// by score, but the dropdown renders them grouped, so the top scorer is no
// longer the first row. Without this, Enter-without-arrowing would pick
// whatever happened to sit at the top of the Contacts section instead of the
// thing that actually matched best.
export function indexOfTopHit(results: SearchResult[]): number {
  const top = results[0];
  if (!top) return -1;
  return groupByType(results)
    .flatMap((g) => g.items)
    .findIndex((r) => r.entityType === top.entityType && r.entityId === top.entityId);
}

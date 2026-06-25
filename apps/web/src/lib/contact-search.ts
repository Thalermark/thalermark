import type { DupeCandidate } from '$lib/contact-dupes';

// A contact suggestion from the /contacts/search proxy. Carries email so the
// inline-create dupe hints (findEmailDupe) can run off the same payload.
export type ContactSuggestion = DupeCandidate;

const DEBOUNCE_MS = 200;
const MIN_QUERY = 2;

// Debounced, abortable search against the /contacts/search proxy. Returns a
// scheduler + teardown; results are pushed to the supplied callback so the
// caller can drop them into Svelte $state. ContactPicker uses it three times:
// the selection type-ahead plus the inline-create name + email dupe probes.
export function createContactSearch(onResults: (r: ContactSuggestion[]) => void) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let abort: AbortController | null = null;

  function schedule(q: string) {
    if (timer) clearTimeout(timer);
    if (q.trim().length < MIN_QUERY) {
      onResults([]);
      return;
    }
    timer = setTimeout(() => run(q.trim()), DEBOUNCE_MS);
  }

  async function run(q: string) {
    abort?.abort();
    abort = new AbortController();
    try {
      const res = await fetch(`/contacts/search?q=${encodeURIComponent(q)}`, {
        signal: abort.signal,
      });
      if (!res.ok) {
        onResults([]);
        return;
      }
      const body = (await res.json()) as { contacts: ContactSuggestion[] };
      onResults(body.contacts);
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') return;
      onResults([]);
    }
  }

  function destroy() {
    if (timer) clearTimeout(timer);
    abort?.abort();
  }

  return { schedule, destroy };
}

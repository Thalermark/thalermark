// Pure dupe-detection helpers for the contact create paths (inline on
// /invoices/new and the standalone /contacts/new). Both signals are
// computed client-side against the already-loaded contact list — no extra
// fetch, no new API surface. The server re-runs the same check at submit
// time so the live hint and the hard block stay in lock-step.
//
// Match rules (PROJECT.md "fuzzy name + strong identifier"):
//
//   - Email: exact case-insensitive trimmed equality. Strong signal →
//     callers HARD BLOCK on this. No Gmail-dot / +tag normalization
//     (deliberately — plus-addressing is a legitimate multi-tenant pattern
//     and over-normalizing would surprise users who rely on it).
//
//   - Name: normalize (lowercase, collapse internal whitespace, strip
//     non-alphanumeric) then equal. Soft signal → callers WARN only. Catches
//     "Wile E. Coyote" / "wile e coyote" / "Wile E. Coyote " variants;
//     deliberately misses typos. Typo-fuzzy (Levenshtein / trigram) is a
//     JIT follow-up if real users start hitting it.

export type DupeCandidate = {
  id: string;
  name: string;
  email: string | null;
};

// Posted in the hidden contactId field when the user picks "+ Add new contact"
// in the ContactPicker type-ahead. The invoice/estimate/recurring server
// actions branch on this exact string to run the inline-create flow instead of
// treating the value as a UUID.
export const NEW_CONTACT_SENTINEL = '__new__';

function normalizeEmail(s: string): string {
  return s.trim().toLowerCase();
}

function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function findEmailDupe<T extends DupeCandidate>(
  input: string | undefined | null,
  list: T[],
): T | undefined {
  const needle = input ? normalizeEmail(input) : '';
  if (!needle) return undefined;
  return list.find((c) => c.email && normalizeEmail(c.email) === needle);
}

export function findNameDupes<T extends DupeCandidate>(
  input: string | undefined | null,
  list: T[],
  limit = 3,
): T[] {
  const needle = input ? normalizeName(input) : '';
  if (!needle) return [];
  const out: T[] = [];
  for (const c of list) {
    if (normalizeName(c.name) === needle) {
      out.push(c);
      if (out.length >= limit) break;
    }
  }
  return out;
}

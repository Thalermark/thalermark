import { isCodeShaped, messageForApiError } from '@thalermark/validation';

// The mobile half of the shared error vocabulary (TMC-220). The catalogue itself
// lives in @thalermark/validation so this file and its web twin cannot drift —
// they were byte-identical copies covering two codes between them, and every
// other code reached the screen as a raw string.
//
// Most error codes belong to one route and are handled where they're raised.
// This is for the CROSS-CUTTING ones — raised deep in the ledger rather than by
// a particular handler, so every screen that writes money can surface them
// without each one re-inventing the sentence.

// A closed fiscal year rejects any posting dated inside it — see the period lock
// in apps/api/src/lib/period-lock.ts. Reachable from every money-writing screen:
// a backdated expense, editing an invoice from that year, paying a bill, even
// deleting something, since a delete reverses at the original date.
function periodClosedMessage(closedThrough: string | undefined): string {
  // closed_through is the exclusive upper bound (1 Jan of the following year),
  // so the year the user actually cares about is the one before it.
  const year = closedThrough ? new Date(closedThrough).getUTCFullYear() - 1 : null;
  // "changed" alone undersold it: a closed year also refuses anything NEWLY
  // dated inside it, which is how sending an invoice dated last December can
  // fail in March. Wording covers both so the reader isn't left wondering what
  // the year has to do with what they just did.
  return year
    ? `${year} is closed. Re-open it in the Ledger to record or change anything dated in that year.`
    : 'That year is closed. Re-open it in the Ledger to record or change anything dated in it.';
}

// A business that has stopped trading takes no NEW work — see the retirement
// lock in apps/api/src/lib/company-lock.ts. Reachable from every money-writing
// route, exactly like the period lock, and for the same structural reason: it is
// raised in the posting funnel rather than by any one handler.
//
// Deliberately does not name a date. "Closed on 3 March" invites the reader to
// think the date is the problem; it isn't — the business is finished, and the
// fix is to pick a different one or reopen it.
const COMPANY_RETIRED_MESSAGE =
  "This business is closed, so you can't record new work against it. Switch to another business, or reopen it in Business settings.";

// Pull `closedThrough` off a parsed error body without caring how the call site
// typed it — every screen casts its error body differently, so taking `unknown`
// keeps the call sites free of cast-widening churn.
function closedThroughOf(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || !('closedThrough' in body)) return undefined;
  const value = (body as { closedThrough: unknown }).closedThrough;
  return typeof value === 'string' ? value : undefined;
}

// A code NEVER comes back out. It used to, so that a screen's own switch could
// match on it — and screens rendered the result directly, which is how a user
// who lost signal mid-save was shown the word `create_failed`.
export function apiErrorMessage(
  code: string | undefined,
  fallback: string,
  body?: unknown,
): string {
  // These two need a value out of the body, so they cannot live in the shared
  // catalogue with the rest.
  if (code === 'period_closed') return periodClosedMessage(closedThroughOf(body));
  if (code === 'company_retired') return COMPANY_RETIRED_MESSAGE;

  const known = messageForApiError(code);
  if (known) return known;
  // Already a sentence — a caller translated it before handing it on.
  if (code && !isCodeShaped(code)) return code;
  return fallback;
}

// Mirror of apps/web/src/lib/api-errors.ts — shared translation for API error
// codes that any posting route can return.
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
  return year
    ? `${year} is closed, so it can't be changed. Re-open it in the Ledger first.`
    : "That year is closed, so it can't be changed. Re-open it in the Ledger first.";
}

// Pull `closedThrough` off a parsed error body without caring how the call site
// typed it — every screen casts its error body differently, so taking `unknown`
// keeps the call sites free of cast-widening churn.
function closedThroughOf(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || !('closedThrough' in body)) return undefined;
  const value = (body as { closedThrough: unknown }).closedThrough;
  return typeof value === 'string' ? value : undefined;
}

// An unrecognised code is returned UNCHANGED (falling back only when there was no
// code at all), so this is safe to drop in ahead of a screen's own code switch
// without collapsing its route-specific messages into a generic one.
export function apiErrorMessage(
  code: string | undefined,
  fallback: string,
  body?: unknown,
): string {
  switch (code) {
    case 'period_closed':
      return periodClosedMessage(closedThroughOf(body));
    default:
      return code ?? fallback;
  }
}

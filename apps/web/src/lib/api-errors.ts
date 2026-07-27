// Shared translation for API error codes that any posting route can return.
//
// Most error codes belong to one route and are handled by that route's own
// `formErrorFor` switch. This is for the CROSS-CUTTING ones — raised deep in the
// ledger rather than by a particular handler, so every form that writes money
// can surface them without each one re-inventing the sentence.
//
// The rule that makes it matter: a route's local switch must end in
// `default: return apiErrorMessage(code, '...')` rather than `return code`.
// Returning the code shipped `period_closed` to a user's screen (TMC-159).

// A closed fiscal year rejects any posting dated inside it — see the period lock
// in apps/api/src/lib/period-lock.ts. Reachable from every money-writing route:
// creating a backdated expense, editing an invoice from that year, paying a
// bill, even deleting something, since a delete reverses at the original date.
function periodClosedMessage(closedThrough: string | undefined): string {
  // closed_through is the exclusive upper bound (1 Jan of the following year),
  // so the year the user actually cares about is the one before it.
  const year = closedThrough ? new Date(closedThrough).getUTCFullYear() - 1 : null;
  return year
    ? `${year} is closed, so it can't be changed. Re-open it in the Ledger first.`
    : "That year is closed, so it can't be changed. Re-open it in the Ledger first.";
}

// Pull `closedThrough` off a parsed error body without caring how the call site
// typed it. Every route casts its error body differently (`{ error?: string }`
// in most cases), so taking `unknown` here keeps the ~20 call sites free of
// cast-widening churn.
function closedThroughOf(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || !('closedThrough' in body)) return undefined;
  const value = (body as { closedThrough: unknown }).closedThrough;
  return typeof value === 'string' ? value : undefined;
}

// Translate an API error code to a sentence. `body` is the parsed error response
// when available — some codes carry detail worth naming.
//
// An unrecognised code is returned UNCHANGED (falling back only when there was no
// code at all), which is what makes this safe to drop in anywhere. Several routes
// feed this straight into their own `formErrorFor` switch; if unknown codes
// collapsed to the fallback, those switches would stop matching and every
// route-specific message would regress to a generic one.
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

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
    case 'company_retired':
      return COMPANY_RETIRED_MESSAGE;
    default:
      return code ?? fallback;
  }
}

// --- Settlement guards (TMC-187 invoices, TMC-192 bills) --------------------
// Once a document can be PARTLY settled, several actions that used to be always
// available start refusing, and each refusal is a rule the user did not know
// existed. They are shared here rather than per route because invoices and
// bills raise the identical codes for the identical reasons — the only thing
// that differs is the noun.
//
// Without this they reach the screen as raw codes: apiErrorMessage returns an
// unrecognised code UNCHANGED, deliberately, so route-specific switches keep
// matching. That is exactly how a user voiding a part-paid invoice was shown
// the string "has_payments".
//
// Every sentence says what to do next rather than what failed.
export type SettlementNoun = 'invoice' | 'bill';

const SETTLEMENT_ERRORS: Record<string, (noun: SettlementNoun) => string> = {
  // Void refuses because its posting reverses the FULL amount, which would
  // undo relief the payments already gave. Mark-paid refuses because it would
  // settle the whole amount a second time.
  has_payments: (noun) =>
    `This ${noun} has payments recorded against it — remove or refund those first.`,
  // Settled by the old one-shot path: no payment rows, and the money has
  // already moved, so another payment would double it.
  settled_without_payments: (noun) =>
    `This ${noun} was settled in one go, so there is nothing left to record against it.`,
  voided: (noun) => `This ${noun} was voided, so no more money can be recorded against it.`,
  // Invoice-only: a payment pays down a receivable and a draft has posted none.
  not_issued: () => 'Send this invoice first — there is nothing owed on a draft to pay down.',
  // Bill-only: the chart marks several things assets that money cannot leave.
  invalid_payment_account: () => "That account isn't one a bill can be paid from.",
};

export function settlementErrorMessage(
  code: string | undefined,
  noun: SettlementNoun,
  fallback: string,
  body?: unknown,
): string {
  const build = code ? SETTLEMENT_ERRORS[code] : undefined;
  return build ? build(noun) : apiErrorMessage(code, fallback, body);
}

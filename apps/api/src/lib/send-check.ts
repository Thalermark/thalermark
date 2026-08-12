import { centsToMoney, formatMoneyDisplay } from '@thalermark/validation';

// The typo catcher (TMC-227, PR 2).
//
// A landscaper types $450 instead of $4,500 and hits Send. PR 1 made that
// recoverable; this tries to catch it before the customer ever sees it.
//
// DETERMINISTIC, AND NO LLM ANYWHERE NEAR IT. The design target is someone
// standing in a driveway with one bar of signal and a thumb already moving
// toward Send. A model round trip is three seconds he does not have, a cost per
// send the free tier cannot carry, and — worst — a source of advice that varies
// between two identical invoices. Everything here is arithmetic over numbers the
// database already holds, so the answer is instant, free, and the same every
// time.
//
// IT NEVER BLOCKS. There is no "are you sure?", no second tap, no dismissal
// state to remember. It renders a sentence above the Send button or it renders
// nothing at all. The 60-second send hold from the first attempt at TMC-227 is
// dead and this is not it in disguise: an invoice that is genuinely ten times
// the usual one must go out on the first tap, exactly as fast as any other.
//
// WHICH MEANS SILENCE IS THE DEFAULT AND FALSE POSITIVES ARE THE ONLY REAL
// COST. A warning that fires on a bigger-than-usual job teaches the user to
// read past it, and then it is not there when the dropped zero happens. Every
// threshold below is deliberately loose for that reason, and roughly half the
// test suite asserts that nothing is said.

export type SendConcernSignal = 'job_cost' | 'power_of_ten' | 'median';

export type SendConcern = {
  signal: SendConcernSignal;
  // A whole sentence, ready to render. Built here rather than in the clients so
  // web and mobile cannot drift, and so the thresholds and the words that
  // explain them live in one file.
  concern: string;
};

export type SendCheckInput = {
  totalCents: number;
  // What this invoice's customer was billed on their last five ISSUED invoices,
  // in cents, most recent first. Drafts are excluded deliberately — see below.
  priorIssuedTotalsCents: number[];
  // Money recorded against the job this invoice belongs to, in cents. Undefined
  // when the invoice is not on a job, which is most of them.
  jobCostCents?: number;
  // The customer's name, for the sentence. Falls back to "this customer".
  customerName?: string | null;
  currency?: string;
};

// Below this, say nothing at all — whatever the ratios do.
//
// Ratios are meaningless at small amounts: $4 against a $40 median is a
// power-of-ten "miss" and nobody cares, because nobody drops a zero on the
// number they charge for a bag of mulch. $50 is the gap where a mistake starts
// costing more than the interruption does.
const MIN_ABSOLUTE_GAP_CENTS = 5_000;

// How close to exactly 10× or exactly ⅒ counts as a dropped zero. Tight on
// purpose: the whole claim of this signal is "that looks like a keystroke, not
// a bigger job", and it can only make that claim about a number that really is
// a power of ten away.
const POWER_OF_TEN_TOLERANCE = 0.02;

// The loose signal's bounds. Four times, not twice — a 50% swing is a bigger
// yard, a doubled invoice is a longer job, and only around 4× does "this is not
// the same kind of work" become the likelier reading.
const MEDIAN_HIGH_RATIO = 4;
const MEDIAN_LOW_RATIO = 0.25;

// Three priors before the median means anything. Two is not a habit.
const MIN_PRIORS_FOR_MEDIAN = 3;

function money(cents: number, currency: string): string {
  return formatMoneyDisplay(centsToMoney(cents), currency);
}

// Middle value, not the mean. One $9,000 job in a history of $200 mowings would
// drag a mean far enough to make every subsequent invoice look normal — which
// is precisely backwards, since that outlier is the shape of the thing being
// looked for.
// Exported so customer-insights can state the same figure this warning compares
// against. Two implementations of "what you usually bill them" is how the page
// and the warning end up disagreeing in front of the user.
export function medianCents(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

// Pure. Given one invoice and the little the system already knows about its
// customer and its job, either say one thing or say nothing.
//
// The signals are tried in order of how much they actually know, and the FIRST
// one to fire wins. Only one sentence is ever shown: two warnings above a Send
// button is a dialog, and a dialog is the thing this is not.
export function computeSendConcern(input: SendCheckInput): SendConcern | null {
  const { totalCents, priorIssuedTotalsCents, jobCostCents } = input;
  const currency = input.currency ?? 'USD';
  const who = input.customerName?.trim() || 'this customer';

  // Nothing sensible to say about a zero or negative invoice, and the ratios
  // below would divide by it.
  if (totalCents <= 0) return null;

  // 1. Arithmetic, not statistics — and the only signal here that is a FACT
  //    rather than a pattern. If the receipts filed against this job already
  //    exceed what the invoice asks for, the business is losing money on it,
  //    and that is worth one sentence whether or not the amount looks typical.
  //
  //    No threshold beyond the floor, because there is no "usually" to compare
  //    against: billing less than a job cost is either a mistake or a decision,
  //    and the sentence is phrased so that a decision reads past it easily.
  if (jobCostCents !== undefined && jobCostCents - totalCents >= MIN_ABSOLUTE_GAP_CENTS) {
    return {
      signal: 'job_cost',
      concern: `This invoice (${money(totalCents, currency)}) is less than the ${money(jobCostCents, currency)} you've recorded spending on this job.`,
    };
  }

  // The customer's habit. DRAFTS ARE EXCLUDED, which is the load-bearing
  // decision in this whole file: a wrong draft sitting in the list is exactly
  // the mistake being hunted, and letting it into the baseline teaches the
  // check that wrong is normal. Voided is excluded for the same reason from the
  // other direction — a cancelled invoice is not evidence of anything.
  if (priorIssuedTotalsCents.length === 0) return null;
  const median = medianCents(priorIssuedTotalsCents);
  if (median <= 0) return null;
  if (Math.abs(totalCents - median) < MIN_ABSOLUTE_GAP_CENTS) return null;
  const ratio = totalCents / median;

  // 2. The dropped zero, named outright. This is the ONE case where the check
  //    can say what it thinks actually happened rather than just that something
  //    is unusual — and naming it is what makes the sentence worth reading,
  //    because the user can confirm or dismiss it in one glance at the number.
  //
  //    Fires on a SINGLE prior, unlike the loose signal below. Ten times is not
  //    a pattern claim; it is a claim about the shape of one keystroke.
  const isTenTimes = Math.abs(ratio - 10) <= 10 * POWER_OF_TEN_TOLERANCE;
  const isTenth = Math.abs(ratio - 0.1) <= 0.1 * POWER_OF_TEN_TOLERANCE;
  if (isTenTimes || isTenth) {
    return {
      signal: 'power_of_ten',
      concern: `That's almost exactly ${isTenTimes ? 'ten times' : 'a tenth of'} what you usually bill ${who} — worth checking for a dropped zero.`,
    };
  }

  // 3. The loose one. Says only what it knows: here is the usual number, here
  //    is this one. No theory about why, because it has none — and a check that
  //    guesses wrong out loud is worse than one that states two figures and
  //    lets the person who did the work decide.
  if (priorIssuedTotalsCents.length < MIN_PRIORS_FOR_MEDIAN) return null;
  if (ratio >= MEDIAN_HIGH_RATIO || ratio <= MEDIAN_LOW_RATIO) {
    return {
      signal: 'median',
      concern: `You usually bill ${who} around ${money(median, currency)} — this one is ${money(totalCents, currency)}.`,
    };
  }

  return null;
}

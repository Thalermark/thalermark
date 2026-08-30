// Who to chase (TMC-262, mobile half is TMC-285). Deterministic: the API ranks
// worst-first by overdue money and this only assembles the sentence, so no model
// is called and nothing is gated.
//
// The sentence is built HERE rather than inline in the screen because its rules
// are the interesting part and they are testable. Web builds the same line in
// `apps/web/src/routes/(app)/+page.svelte`; keep the two in lockstep, or one
// customer gets described two different ways depending on which client you open.

export type LatePayer = {
  contactId: string;
  name: string;
  outstanding: string;
  maxDaysPastDue: number | null;
  paidCount: number;
  lateCount: number;
};

// Two omissions, and both are the parent epic's thesis rather than cosmetics:
// the app must not state things the data does not support.
//
//  - No pattern claim under two settled invoices. "Paid late 1 of 1 times" is not
//    a pattern, it is one data point wearing a statistic's clothes.
//  - No days-past-due when maxDaysPastDue is null. A contact can appear on their
//    late HISTORY while currently owing nothing overdue, and printing
//    "0 days past due" there would simply be false.
export function chaseLine(payer: LatePayer, money: (amount: string) => string): string {
  const parts = [`${money(payer.outstanding)} outstanding`];
  if (payer.maxDaysPastDue !== null) parts.push(`${payer.maxDaysPastDue} days past due`);
  if (payer.paidCount >= 2 && payer.lateCount > 0) {
    parts.push(`paid late ${payer.lateCount} of ${payer.paidCount} times`);
  }
  return parts.join(' · ');
}

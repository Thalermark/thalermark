// The welcome wizard's steps, in order, keyed by path.
//
// Named WELCOME_ rather than ONBOARDING_ on purpose: @thalermark/validation
// already exports an ONBOARDING_STEPS, and it means something else entirely —
// the server-authoritative telemetry milestones (company_setup, first_client,
// first_invoice, first_expense). These are wizard route paths. Two exported
// constants with one name and two meanings is a trap for whoever imports both.
//
// This list is a second source of truth about a directory of routes, which is
// the failure mode it has already produced once: /welcome/books shipped as a
// real step and was never added here. Two things broke on the same omission
// (TMC-234).
//
//   - the counter. indexOf returned -1, the Math.max fallback clamped it to 1,
//     and the final step announced "Step 1 of 3" with the progress bar emptied,
//     so pressing Next on the last step read as being sent back to the start.
//
//   - onboarding_abandoned. books is the step that HOLDS the exits — "Send your
//     first invoice" leaves to /invoices/new and "Skip for now" leaves to / —
//     so both intended ways to finish the wizard fired the abandonment event.
//     That inverted the metric where it matters most: the further someone got,
//     the likelier they were counted as a drop-out.
//
// welcomeStepsMatchRoutes below is pinned by a test that reads the routes
// directory, so the next step added to the wizard fails CI rather than silently
// repeating this.
export const WELCOME_STEPS = [
  '/welcome',
  '/welcome/paid',
  '/welcome/brand',
  '/welcome/books',
] as const;

// Leaving the wizard from one of these is finishing, not abandoning.
//
// /welcome/brand has counted since the event was added: the wizard's core ends
// there and books is optional on top. books belongs here too, for the exit
// reason above — it is where a completing user actually leaves from.
export const WELCOME_FINISHED_FROM: ReadonlySet<string> = new Set([
  '/welcome/brand',
  '/welcome/books',
]);

// 1-based position for display. Anything unmatched falls back to the first step,
// which is the behaviour that hid the missing path rather than surfacing it —
// kept because a wrong number beats a crash mid-signup, and the test now catches
// the case that made it fire.
export function welcomeStepNumber(pathname: string): number {
  const i = (WELCOME_STEPS as readonly string[]).indexOf(pathname);
  return Math.max(0, i) + 1;
}

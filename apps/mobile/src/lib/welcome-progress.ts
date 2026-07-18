// Shared progress for the welcome wizard so the group _layout can emit
// onboarding_abandoned when the user leaves the wizard without finishing.
// index.tsx marks company_setup done; brand.tsx (the only screen that exits the
// wizard into the app) marks it finished. _layout resets on entry and reads on
// exit. Module-level because the value must outlive the individual step screens
// (each a separate route) but only spans one wizard visit.
type Progress = { lastCompletedStep: 'company_setup' | null; finished: boolean };

const progress: Progress = { lastCompletedStep: null, finished: false };

export function resetWelcomeProgress(): void {
  progress.lastCompletedStep = null;
  progress.finished = false;
}

export function markCompanySetupDone(): void {
  progress.lastCompletedStep = 'company_setup';
}

export function markWelcomeFinished(): void {
  progress.finished = true;
}

export function readWelcomeProgress(): Progress {
  return progress;
}

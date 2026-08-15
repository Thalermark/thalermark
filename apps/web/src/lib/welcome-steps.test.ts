import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WELCOME_FINISHED_FROM, WELCOME_STEPS, welcomeStepNumber } from './welcome-steps';

// The regression pin for TMC-234. /welcome/books was a real step missing from
// the list, which broke the counter and inverted onboarding_abandoned at once.
describe('welcome wizard steps', () => {
  it('numbers the last step last, not first', () => {
    // The actual defect: the final step read "Step 1 of 3" and the progress bar
    // collapsed, so pressing Next appeared to send the user backwards at the
    // exact moment a signup is being converted.
    expect(welcomeStepNumber('/welcome/books')).toBe(WELCOME_STEPS.length);
    expect(welcomeStepNumber('/welcome/books')).not.toBe(1);
  });

  it('numbers every step in route order', () => {
    expect(welcomeStepNumber('/welcome')).toBe(1);
    expect(welcomeStepNumber('/welcome/paid')).toBe(2);
    expect(welcomeStepNumber('/welcome/brand')).toBe(3);
    expect(welcomeStepNumber('/welcome/books')).toBe(4);
  });

  it('still falls back rather than crashing on an unknown path', () => {
    expect(welcomeStepNumber('/welcome/nope')).toBe(1);
  });

  it('treats both of the last step’s exits as finishing', () => {
    // books links out to /invoices/new and to /, neither under /welcome. With
    // books absent from this set, a user who completed the wizard was recorded
    // as having abandoned it.
    expect(WELCOME_FINISHED_FROM.has('/welcome/books')).toBe(true);
    expect(WELCOME_FINISHED_FROM.has('/welcome/brand')).toBe(true);
  });

  it('still counts leaving an early step as abandonment', () => {
    // The control. Without this the test above would pass on a set that simply
    // exempted everything, and the event would never fire at all.
    expect(WELCOME_FINISHED_FROM.has('/welcome')).toBe(false);
    expect(WELCOME_FINISHED_FROM.has('/welcome/paid')).toBe(false);
  });

  // The part that stops this recurring. The list above duplicates a directory of
  // routes, so it can drift out of date silently — which is exactly how the bug
  // this file exists for was introduced.
  it('lists every route that actually exists under /welcome', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const welcomeDir = resolve(here, '../routes/welcome');

    const routes = ['/welcome'];
    for (const entry of readdirSync(welcomeDir, { withFileTypes: true })) {
      if (entry.isDirectory()) routes.push(`/welcome/${entry.name}`);
    }

    expect([...WELCOME_STEPS].sort()).toEqual(routes.sort());
  });
});

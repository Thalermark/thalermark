import { defineConfig, devices } from '@playwright/test';

// The layer nothing else in the repo can see (TMC-249).
//
// 1,167 API tests, ~100 web tests, a typechecker and a linter all run BELOW the
// browser, so a defect that exists only in what the user sees is invisible to
// every one of them. On 2026-08-10 that cost four consecutive commits which
// typechecked, linted and passed the whole suite while the bug was still there.
//
// Deliberately thin. This is not a second functional test suite — the API tests
// own correctness and are much faster at it. These assertions cover the things
// that are only true on a rendered page.
//
// Kept out of `pnpm test` (vitest) and run by its own command, because it needs
// a whole stack up: postgres, the api, and the web server. See ci.yml.
const PORT = Number(process.env.PLAYWRIGHT_WEB_PORT ?? 4173);

export default defineConfig({
  testDir: './e2e',
  // A route walk visits every page in the app; without this the wall time is
  // the sum of them rather than the slowest few.
  fullyParallel: true,
  // A flaky browser test is worse than no browser test: it trains people to
  // re-run CI instead of reading it. No retries, so flake surfaces as a
  // failure to fix rather than a wobble to absorb.
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    // On failure, the two artefacts that answer "what did the user see" — which
    // is the entire reason this suite exists.
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    // Signs up a throwaway account and clears the three gates that block every
    // in-app page, then saves the session for the suites that need one.
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: 'e2e/.auth/state.json' },
      dependencies: ['setup'],
    },
  ],
  // Assumes the API is already up (CI starts it as a step; locally you have it
  // running anyway). Only the web server is managed here, because it is the one
  // whose port this config owns.
  webServer: {
    command: `pnpm exec vite dev --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});

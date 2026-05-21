import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./tests/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Single fork: tests share one testcontainer-managed Postgres and use
    // TRUNCATE in beforeEach to isolate. Parallel workers would race on the
    // shared DB. Slight performance cost for safety; revisit if test count grows.
    pool: 'forks',
    maxWorkers: 1,
    isolate: false,
  },
});

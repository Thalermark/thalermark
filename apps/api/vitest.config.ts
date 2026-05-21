import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./tests/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // One testcontainer per run; tests share the same Postgres and rely
    // on TRUNCATE between describe blocks (see tests/test-helper.ts).
    pool: 'forks',
    maxWorkers: 1,
    isolate: false,
  },
});

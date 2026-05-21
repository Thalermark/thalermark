import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./tests/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Same constraint as @thalermark/db: tests share one testcontainer-managed
    // Postgres and rely on TRUNCATE between tests for isolation.
    pool: 'forks',
    maxWorkers: 1,
    isolate: false,
  },
});

import { loadEnvFile } from 'node:process';
import { defineConfig } from 'drizzle-kit';

try {
  loadEnvFile('.env');
} catch {
  // .env not present (CI, production) — use existing process.env
}

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL is required (set in .env or environment)');
}

export default defineConfig({
  schema: './packages/db/src/schema/*.ts',
  out: './packages/db/migrations',
  dialect: 'postgresql',
  dbCredentials: { url },
  verbose: true,
  strict: true,
});

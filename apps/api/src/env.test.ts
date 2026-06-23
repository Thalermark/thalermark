import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

// Minimal source that satisfies loadEnv's required-field throws. Individual
// tests spread extra keys on top.
const base: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgres://localhost/x',
  APP_DATABASE_URL: 'postgres://localhost/x',
  BETTER_AUTH_SECRET: 'test-secret',
  BETTER_AUTH_URL: 'http://localhost:3000',
};

// Regression: a bare `KEY=` in .env / compose env_file arrives as "" (not
// undefined), which used to collapse these tri-state flags to a hard false and
// defeat their fallbacks — most visibly REQUIRE_EMAIL_VERIFICATION=, which
// silently disabled email verification even with a mailer configured.
describe('loadEnv — empty-string env vars are treated as unset', () => {
  it('REQUIRE_EMAIL_VERIFICATION="" => undefined (defers to the mailer default)', () => {
    expect(loadEnv({ ...base, REQUIRE_EMAIL_VERIFICATION: '' }).requireEmailVerification).toBeUndefined();
  });

  it('REQUIRE_EMAIL_VERIFICATION unset => undefined', () => {
    expect(loadEnv(base).requireEmailVerification).toBeUndefined();
  });

  it('REQUIRE_EMAIL_VERIFICATION explicit true/false still parse', () => {
    expect(loadEnv({ ...base, REQUIRE_EMAIL_VERIFICATION: 'true' }).requireEmailVerification).toBe(true);
    expect(loadEnv({ ...base, REQUIRE_EMAIL_VERIFICATION: 'false' }).requireEmailVerification).toBe(false);
  });

  it('RATE_LIMIT_ENABLED="" => falls back to the NODE_ENV default', () => {
    expect(loadEnv({ ...base, NODE_ENV: 'production', RATE_LIMIT_ENABLED: '' }).rateLimitEnabled).toBe(true);
    expect(loadEnv({ ...base, NODE_ENV: 'development', RATE_LIMIT_ENABLED: '' }).rateLimitEnabled).toBe(false);
  });

  it('RATE_LIMIT_ENABLED="false" disables even in production', () => {
    expect(loadEnv({ ...base, NODE_ENV: 'production', RATE_LIMIT_ENABLED: 'false' }).rateLimitEnabled).toBe(false);
  });
});

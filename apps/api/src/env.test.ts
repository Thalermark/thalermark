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
    expect(
      loadEnv({ ...base, REQUIRE_EMAIL_VERIFICATION: '' }).requireEmailVerification,
    ).toBeUndefined();
  });

  it('REQUIRE_EMAIL_VERIFICATION unset => undefined', () => {
    expect(loadEnv(base).requireEmailVerification).toBeUndefined();
  });

  it('REQUIRE_EMAIL_VERIFICATION explicit true/false still parse', () => {
    expect(loadEnv({ ...base, REQUIRE_EMAIL_VERIFICATION: 'true' }).requireEmailVerification).toBe(
      true,
    );
    expect(loadEnv({ ...base, REQUIRE_EMAIL_VERIFICATION: 'false' }).requireEmailVerification).toBe(
      false,
    );
  });

  it('RATE_LIMIT_ENABLED="" => falls back to the NODE_ENV default', () => {
    expect(
      loadEnv({ ...base, NODE_ENV: 'production', RATE_LIMIT_ENABLED: '' }).rateLimitEnabled,
    ).toBe(true);
    expect(
      loadEnv({ ...base, NODE_ENV: 'development', RATE_LIMIT_ENABLED: '' }).rateLimitEnabled,
    ).toBe(false);
  });

  it('RATE_LIMIT_ENABLED="false" disables even in production', () => {
    expect(
      loadEnv({ ...base, NODE_ENV: 'production', RATE_LIMIT_ENABLED: 'false' }).rateLimitEnabled,
    ).toBe(false);
  });

  it('JOBS_ENABLED defaults to true (unset or empty)', () => {
    expect(loadEnv(base).jobsEnabled).toBe(true);
    expect(loadEnv({ ...base, JOBS_ENABLED: '' }).jobsEnabled).toBe(true);
  });

  it('JOBS_ENABLED="false" disables the scheduler/worker', () => {
    expect(loadEnv({ ...base, JOBS_ENABLED: 'false' }).jobsEnabled).toBe(false);
    expect(loadEnv({ ...base, JOBS_ENABLED: 'true' }).jobsEnabled).toBe(true);
  });
});

// audit S5 — a bare `docker compose up` on the shipped `.env.example` /
// docker-compose.yml defaults must refuse to boot in production rather than
// silently run on predictable, account-takeover creds. Dev/CI (which use these
// same defaults intentionally) stay unaffected.
const weakDefaults: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgres://thalermark:thalermark@localhost:5432/thalermark',
  APP_DATABASE_URL: 'postgres://thalermark_app:thalermark_app@localhost:5432/thalermark',
  PGBOSS_DATABASE_URL: 'postgres://thalermark_pgboss:thalermark_pgboss@localhost:5432/thalermark',
  THALERMARK_APP_PASSWORD: 'thalermark_app',
  THALERMARK_PGBOSS_PASSWORD: 'thalermark_pgboss',
  BETTER_AUTH_SECRET: 'replace-me-with-a-long-random-string',
  BETTER_AUTH_URL: 'http://localhost:3000',
};

describe('loadEnv — refuse weak default secrets in production', () => {
  it('production + shipped defaults throws, naming every offender', () => {
    let message = '';
    try {
      loadEnv({ ...weakDefaults, NODE_ENV: 'production' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('BETTER_AUTH_SECRET');
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('APP_DATABASE_URL');
    expect(message).toContain('PGBOSS_DATABASE_URL');
    expect(message).toContain('THALERMARK_APP_PASSWORD');
    expect(message).toContain('THALERMARK_PGBOSS_PASSWORD');
  });

  it('production + strong secrets boots', () => {
    expect(() =>
      loadEnv({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://thalermark:S3cure-pg-pw@db:5432/thalermark',
        APP_DATABASE_URL: 'postgres://thalermark_app:An0ther-strong-pw@db:5432/thalermark',
        PGBOSS_DATABASE_URL: 'postgres://thalermark_pgboss:Y3t-another-pw@db:5432/thalermark',
        THALERMARK_APP_PASSWORD: 'An0ther-strong-pw',
        THALERMARK_PGBOSS_PASSWORD: 'Y3t-another-pw',
        BETTER_AUTH_SECRET: 'a-genuinely-random-secret-value-not-the-placeholder',
        BETTER_AUTH_URL: 'https://app.thalermark.com',
      }),
    ).not.toThrow();
  });

  it('a strong DB password on the default username is not flagged', () => {
    // The guard keys on the password only, so username `thalermark` with a
    // strong password (a realistic prod config) must pass.
    expect(() =>
      loadEnv({
        ...weakDefaults,
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://thalermark:S3cure-pg-pw@db:5432/thalermark',
        APP_DATABASE_URL: 'postgres://thalermark_app:An0ther-strong-pw@db:5432/thalermark',
        PGBOSS_DATABASE_URL: 'postgres://thalermark_pgboss:Y3t-another-pw@db:5432/thalermark',
        THALERMARK_APP_PASSWORD: 'An0ther-strong-pw',
        THALERMARK_PGBOSS_PASSWORD: 'Y3t-another-pw',
        BETTER_AUTH_SECRET: 'a-genuinely-random-secret-value-not-the-placeholder',
      }),
    ).not.toThrow();
  });

  it('dev/test + shipped defaults boots (local convenience preserved)', () => {
    expect(() => loadEnv({ ...weakDefaults, NODE_ENV: 'development' })).not.toThrow();
    expect(() => loadEnv({ ...weakDefaults, NODE_ENV: 'test' })).not.toThrow();
    expect(() => loadEnv(weakDefaults)).not.toThrow(); // NODE_ENV unset => development
  });
});

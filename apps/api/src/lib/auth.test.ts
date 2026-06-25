import { describe, expect, it } from 'vitest';
import { verifyUrlWithAppCallback } from './auth.js';

// The verification link's host stays the API origin (Better Auth serves
// /api/auth/verify-email there); only the embedded callbackURL — where BA
// redirects AFTER a successful verify — is steered to the web app.
describe('verifyUrlWithAppCallback', () => {
  const API = 'http://localhost:3000';
  const APP = 'http://localhost:5173';

  it("resolves BA's default relative callbackURL ('/') against the web app", () => {
    const link = verifyUrlWithAppCallback(
      `${API}/api/auth/verify-email?token=abc&callbackURL=%2F`,
      APP,
    );
    const u = new URL(link);
    // verify endpoint untouched (still the API origin) …
    expect(u.origin).toBe(API);
    expect(u.pathname).toBe('/api/auth/verify-email');
    expect(u.searchParams.get('token')).toBe('abc');
    // … but the post-verify redirect now lands on the app.
    expect(u.searchParams.get('callbackURL')).toBe(`${APP}/`);
  });

  it('preserves a relative callbackURL path when steering it to the app', () => {
    const link = verifyUrlWithAppCallback(
      `${API}/api/auth/verify-email?token=t&callbackURL=%2Fwelcome`,
      APP,
    );
    expect(new URL(link).searchParams.get('callbackURL')).toBe(`${APP}/welcome`);
  });

  it('defaults a missing callbackURL to the app root', () => {
    const link = verifyUrlWithAppCallback(`${API}/api/auth/verify-email?token=t`, APP);
    expect(new URL(link).searchParams.get('callbackURL')).toBe(`${APP}/`);
  });

  it('leaves an absolute callbackURL (e.g. a deep link) untouched', () => {
    const deep = 'thalermark://verified';
    const link = verifyUrlWithAppCallback(
      `${API}/api/auth/verify-email?token=t&callbackURL=${encodeURIComponent(deep)}`,
      APP,
    );
    expect(new URL(link).searchParams.get('callbackURL')).toBe(deep);
  });

  it('is a no-op when web + API share an origin (single-origin prod)', () => {
    const link = verifyUrlWithAppCallback(
      `${API}/api/auth/verify-email?token=t&callbackURL=%2F`,
      API,
    );
    expect(new URL(link).searchParams.get('callbackURL')).toBe(`${API}/`);
  });

  it('returns the input unchanged when it is not a parseable URL', () => {
    expect(verifyUrlWithAppCallback('not a url', APP)).toBe('not a url');
  });
});

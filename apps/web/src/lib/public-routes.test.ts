import { describe, expect, it } from 'vitest';
import { PUBLIC_PATHS, REDIRECT_IF_AUTHED, isPublicPrefix } from './public-routes';

// The regression pin for TMC-209. /pay/ was absent from PUBLIC_PREFIXES, so the
// Pay button on a public invoice bounced the customer to /sign-in and online
// payment was unreachable for everyone who wasn't already logged in.
describe('public route guard', () => {
  it('lets an anonymous customer reach the whole invoice → pay path', () => {
    // The two halves of one journey. /i/ alone is not enough: the invoice view
    // links straight to /pay/, so a public /i/ with a private /pay/ is a dead
    // end at the exact moment the customer tries to hand over money.
    expect(isPublicPrefix('/i/tok_abc123')).toBe(true);
    expect(isPublicPrefix('/pay/tok_abc123')).toBe(true);
  });

  it('keeps the other token-authorized public views open', () => {
    expect(isPublicPrefix('/e/tok_abc123')).toBe(true);
    expect(isPublicPrefix('/legal/terms')).toBe(true);
    expect(isPublicPrefix('/legal/privacy')).toBe(true);
  });

  it('does not open the app to anonymous visitors', () => {
    // The control. Without these the test above would pass on a guard that
    // simply let everything through.
    for (const path of ['/', '/invoices', '/expenses', '/settings/ai', '/reports']) {
      expect(isPublicPrefix(path)).toBe(false);
      expect(PUBLIC_PATHS.has(path)).toBe(false);
    }
  });

  it('matches on the prefix, not a bare substring', () => {
    // startsWith, so a private route that merely contains a public segment
    // stays private.
    expect(isPublicPrefix('/invoices/i/123')).toBe(false);
    expect(isPublicPrefix('/admin/pay/123')).toBe(false);
  });

  it('lets someone who cannot sign in reach password recovery', () => {
    // TMC-239. Both were missing from the list, so both 303'd to /sign-in —
    // the recovery form was unreachable and the emailed reset link bounced,
    // for the one group of people who by definition cannot sign in. Same
    // shape as the /pay/ omission: fine while you hold a session, broken for
    // everyone who doesn't.
    expect(PUBLIC_PATHS.has('/forgot-password')).toBe(true);
    expect(PUBLIC_PATHS.has('/reset-password')).toBe(true);
    // The reset link carries ?token=…; the guard matches on pathname, so the
    // exact-match entry is enough and no prefix is needed.
    expect(REDIRECT_IF_AUTHED.has('/reset-password')).toBe(false);
  });

  it('exempts the exact-match public paths, and marks the signed-out-only ones', () => {
    expect(PUBLIC_PATHS.has('/accept-invite')).toBe(true);
    // The error-tracking tunnel: client errors happen to logged-out visitors.
    expect(PUBLIC_PATHS.has('/monitoring')).toBe(true);
    // Signed-out-only — public, but a signed-in visitor gets sent home.
    expect(REDIRECT_IF_AUTHED.has('/sign-in')).toBe(true);
    expect(REDIRECT_IF_AUTHED.has('/sign-up')).toBe(true);
    expect(REDIRECT_IF_AUTHED.has('/monitoring')).toBe(false);
  });
});

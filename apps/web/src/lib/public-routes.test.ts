import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PRIVATE_ON_PURPOSE,
  PUBLIC_PATHS,
  REDIRECT_IF_AUTHED,
  isPublicPrefix,
} from './public-routes';

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

// ---------------------------------------------------------------------------
// The test the three shipped bugs actually needed.
//
// Everything above confirms entries that someone remembered to add, which means
// it can only fail for a route we already know about. It could never have
// caught /pay/, /forgot-password or /reset-password, because on the day each of
// those shipped there was nothing to assert.
//
// This one reads the routes directory instead. Every route outside the (app)
// group must be classified — public, or deliberately private — and a new one is
// in neither list until a person puts it there. So the failure lands on the PR
// that adds the route, not on a customer who cannot pay.
describe('every route outside (app) is deliberately classified', () => {
  const routesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../routes');

  // The URL roots a request can actually arrive at. SvelteKit (group) folders
  // are not URL segments, so they are opened one level rather than counted;
  // everything else contributes its own name. Directories only — +layout files
  // and friends are not routes.
  function routeRoots(): string[] {
    const roots: string[] = [];
    for (const entry of readdirSync(routesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === '(app)') continue; // private by default, and correctly so
      if (entry.name.startsWith('(') && entry.name.endsWith(')')) {
        for (const child of readdirSync(join(routesDir, entry.name), { withFileTypes: true })) {
          if (child.isDirectory()) roots.push(`/${child.name}`);
        }
        continue;
      }
      roots.push(`/${entry.name}`);
    }
    return roots.sort();
  }

  // Covered as an exact path, or as a prefix. The trailing slash matters:
  // PUBLIC_PREFIXES holds '/i/', and '/i'.startsWith('/i/') is false.
  const isPublic = (root: string) => PUBLIC_PATHS.has(root) || isPublicPrefix(`${root}/`);

  it('finds the routes at all', () => {
    // Guards the guard. If the directory walk silently returned nothing, the
    // classification test below would pass while asserting about an empty set —
    // a green check that proves the opposite of what it claims.
    const roots = routeRoots();
    expect(roots.length).toBeGreaterThan(5);
    expect(roots).toContain('/sign-in');
    expect(roots).toContain('/pay');
  });

  it('classifies each one, with no route left to silence', () => {
    const unclassified = routeRoots().filter((r) => !isPublic(r) && !PRIVATE_ON_PURPOSE.has(r));
    // Named in the failure so the next person is told exactly what to do.
    expect(
      unclassified,
      `Unclassified route(s): ${unclassified.join(', ')}. Add each to PUBLIC_PATHS or
       PUBLIC_PREFIXES if a signed-out visitor must reach it, or to PRIVATE_ON_PURPOSE
       if it genuinely needs a session. Silence is how /pay/ and /forgot-password shipped broken.`,
    ).toEqual([]);
  });

  it('keeps the two lists disjoint', () => {
    // A route in both is a contradiction someone should resolve, and it would
    // otherwise satisfy the check above for the wrong reason.
    const both = [...PRIVATE_ON_PURPOSE].filter((r) => isPublic(r));
    expect(both).toEqual([]);
  });

  it('does not carry entries for routes that no longer exist', () => {
    // Stops PRIVATE_ON_PURPOSE rotting into a list of historical names, which
    // would quietly weaken the check above.
    const roots = new Set(routeRoots());
    expect([...PRIVATE_ON_PURPOSE].filter((r) => !roots.has(r))).toEqual([]);
  });
});

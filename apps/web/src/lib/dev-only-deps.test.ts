import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Playwright is a test tool, not part of the product (TMC-249).
//
// The decision when it was approved was explicit: a dev dependency, never in the
// deployed application stack. The runtime image deliberately carries no browser
// — that is why the original Playwright plan was dropped when invoice PDFs were
// cut, and it is still true.
//
// "We agreed not to" is not a mechanism. A `pnpm add` without `-D` is one
// keystroke, `dependencies` and `devDependencies` sit four lines apart, and the
// consequence — a few hundred megabytes of browser in a self-hoster's image —
// shows up at deploy time, in someone else's docker pull, months later. So the
// agreement is a test.

const here = dirname(fileURLToPath(import.meta.url));

function productionDeps(pkgPath: string): string[] {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  return Object.keys(pkg.dependencies ?? {});
}

// Anything that pulls a browser, a driver, or a test runner behind it.
const NEVER_SHIPPED = [/^@playwright\//, /^playwright/, /^puppeteer/, /^vitest$/, /^@vitest\//];

describe('the deployed app ships no test tooling', () => {
  const packages = {
    web: resolve(here, '../../package.json'),
    api: resolve(here, '../../../api/package.json'),
  };

  for (const [name, pkgPath] of Object.entries(packages)) {
    it(`${name} declares none of it as a production dependency`, () => {
      const offenders = productionDeps(pkgPath).filter((dep) =>
        NEVER_SHIPPED.some((pattern) => pattern.test(dep)),
      );
      expect(
        offenders,
        `${name}/package.json lists ${offenders.join(', ')} under "dependencies".
         Test tooling belongs in "devDependencies" — the runtime image carries no
         browser and must not start carrying one (TMC-249).`,
      ).toEqual([]);
    });
  }

  // Guards the guard: if the file read or the JSON shape ever changed, the test
  // above would pass while reading nothing at all.
  it('is actually reading the dependency lists', () => {
    expect(productionDeps(packages.web)).toContain('@thalermark/validation');
    expect(productionDeps(packages.api)).toContain('hono');
  });

  it('has Playwright installed, as a dev dependency', () => {
    const pkg = JSON.parse(readFileSync(packages.web, 'utf8')) as {
      devDependencies?: Record<string, string>;
    };
    // The other half of the claim. Without this the suite would still pass if
    // someone removed Playwright entirely, which is a different way to have no
    // browser coverage.
    expect(Object.keys(pkg.devDependencies ?? {})).toContain('@playwright/test');
  });
});

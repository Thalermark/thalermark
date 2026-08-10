import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

// Every page a user can navigate to, checked for the things only a browser can
// see (TMC-249).
//
// ENUMERATED, NOT CURATED — the same trick the public-route classification test
// uses, and for the same reason. A hand-written list only covers the pages
// somebody remembered, which means it can never catch the page that shipped
// wrong; the three bugs behind this ticket were all on pages nobody would have
// thought to add. Reading the routes directory means a route added next month is
// covered the day it lands.
const routesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src/routes');

// Pages reachable by navigating, with no id in the URL. Dynamic segments are
// skipped: [id] needs a record to exist, which is a fixture problem rather than
// a coverage one, and the list pages that link to them are all here.
function navigablePaths(dir = join(routesDir, '(app)'), prefix = ''): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    // Route groups are not URL segments.
    if (name.startsWith('(') && name.endsWith(')')) {
      paths.push(...navigablePaths(join(dir, name), prefix));
      continue;
    }
    // [id] / [...rest] — needs a record, out of scope here.
    if (name.startsWith('[')) continue;
    const child = join(dir, name);
    const url = `${prefix}/${name}`;
    // A directory is a page only if it has a +page.svelte; the rest are
    // endpoints (+server.ts) or layout-only folders.
    if (readdirSync(child).includes('+page.svelte')) paths.push(url);
    paths.push(...navigablePaths(child, url));
  }
  return paths;
}

const PAGES = ['/', ...new Set(navigablePaths())].sort();

// A machine identifier that has reached a user's screen. This one assertion is
// what TMC-245, TMC-219 and TMC-220 all needed and none of them had.
//
// Matched against visible TEXT only — never attributes — because hrefs and form
// values are full of ids by design and always will be.
const SNAKE_CASE = /\b[a-z][a-z0-9]*(_[a-z0-9]+)+\b/;
const BARE_UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
// camelCase is the noisiest of the three — ordinary prose and brand names trip
// it — so it is deliberately narrowed to the shape a leaked column name has:
// a lowercase word followed by a capitalised one, with no space.
const CAMEL_FIELD = /\b[a-z]+[A-Z][a-z]+\b/;

// Text that looks like a violation and is not. Kept short on purpose: every
// entry here is coverage given up, so each needs a reason.
const ALLOWED = [
  // The AI provider names, which are genuinely spelled this way.
  'openAI',
  // A brand, not a field.
  'thalerMark',
];

function offendingText(text: string): string | null {
  for (const line of text.split('\n').map((l) => l.trim())) {
    if (!line || ALLOWED.some((a) => line.includes(a))) continue;
    if (SNAKE_CASE.test(line)) return `snake_case: ${line}`;
    if (BARE_UUID.test(line)) return `uuid: ${line}`;
    if (CAMEL_FIELD.test(line)) return `camelCase: ${line}`;
  }
  return null;
}

test.describe('every navigable page', () => {
  // Guards the assertion, not the app. A detector that never fires is
  // indistinguishable from a clean app, and the whole suite passing on day one
  // is exactly when that mistake is invisible. These are the three real
  // leaks this ticket was filed for.
  test('the detector actually catches what it is for', () => {
    // TMC-219 / TMC-220: an API error code rendered as copy.
    expect(offendingText('invalid_recipient')).toContain('snake_case');
    // TMC-245, first half: a column name rendered as a field label.
    expect(offendingText('deletedAt: empty')).toContain('camelCase');
    // TMC-245, second half: a foreign key rendered as its value.
    expect(offendingText('category: 019febc9-ec21-7000-8000-00000000e86c')).toContain('uuid');
    // And it does not fire on ordinary copy, or the suite would be unusable.
    expect(offendingText('Add at least one line.')).toBeNull();
    expect(offendingText('Could not reach Thalermark. Check your connection.')).toBeNull();
    expect(offendingText('6200 · Commissions & Fees')).toBeNull();
  });

  // Guards the guard. If the directory walk ever returned nothing, the loop
  // below would pass while asserting about an empty set — a green check that
  // proves the opposite of what it claims.
  test('the walk finds the app', () => {
    expect(PAGES.length).toBeGreaterThan(10);
    expect(PAGES).toContain('/invoices');
    expect(PAGES).toContain('/expenses');
    expect(PAGES).toContain('/settings/business');
  });

  for (const path of PAGES) {
    test(`${path} renders, and shows the user nothing from the schema`, async ({ page }) => {
      const response = await page.goto(path);
      expect(response?.status(), `${path} did not return a page`).toBeLessThan(400);

      // It rendered something, rather than an error page or an empty shell.
      await expect(page.locator('h1').first()).toBeVisible();
      const heading = await page.locator('h1').first().innerText();
      expect(heading, `${path} rendered the error page`).not.toMatch(/^(404|500|503)\b/);

      // And nothing on it is an identifier. innerText is what a person can
      // actually read — it excludes attributes, and excludes anything hidden.
      const body = await page.locator('body').innerText();
      const offender = offendingText(body);
      expect(
        offender,
        `${path} shows a machine identifier to the user — ${offender}.
         Give it words, or add it to ALLOWED with a reason (TMC-249).`,
      ).toBeNull();
    });
  }
});

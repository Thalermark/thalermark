import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

// The chart module, asserted in a browser (TMC charts).
//
// Everything below is a claim that only a rendered page can settle. The unit
// tests in @thalermark/charts own the arithmetic — null vs zero, the em dash,
// where a line breaks — and they are much faster at it. What is here instead:
// does a chart actually appear, does its accessible fallback carry the same
// numbers, and — the one that decided the library — is any of it there with
// JavaScript switched off.

const API = process.env.PLAYWRIGHT_API_URL ?? 'http://localhost:3000';
const ORIGIN = process.env.PLAYWRIGHT_ORIGIN ?? 'http://localhost:5173';

type Workspace = { accountId: string; companyId: string };

function workspace(): Workspace {
  return JSON.parse(readFileSync('e2e/.auth/workspace.json', 'utf8')) as Workspace;
}

// The session cookies the setup project saved, flattened into a header. The
// API is a different origin from the app, so Playwright's own request context
// will not carry them for us.
function cookieHeader(): string {
  const state = JSON.parse(readFileSync('e2e/.auth/state.json', 'utf8')) as {
    cookies: { name: string; value: string }[];
  };
  return state.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

// Two issued invoices in known months, so the chart has a shape with a known
// tallest bar rather than whatever the account happens to hold.
const MONTHS = [
  { issueDate: '2026-03-14', total: '1200.00' },
  { issueDate: '2026-04-14', total: '2400.00' },
];

// A deliberately tiny second customer, purely so the share test has something
// that must NOT read 100%. See the assertion at the bottom for why one customer
// could never have proved anything.
const MINOR = { name: 'Chart Minor Ltd', issueDate: '2026-05-14', total: '100.00' };

// SERIAL, and it matters twice over. playwright.config sets fullyParallel, so
// without this the three tests below can land in different workers and each one
// runs beforeAll again. That seeds a SECOND "Chart Fixture Ltd" with its own
// sales, which splits the customer's share and makes the 100% assertion at the
// bottom of this file wrong — and it races two identical `CHART-<Date.now()>`
// invoice numbers, where the create route's number pre-check is explicitly not
// atomic, so the loser raises a constraint violation and answers 500.
//
// These tests share seeded state, so they were never independent; saying so is
// more honest than making the seed defensive enough to survive being run twice.
test.describe.configure({ mode: 'serial' });

// Unique per run AND per worker even if serial mode is ever lifted — the same
// belt-and-braces auth.setup.ts uses for its throwaway email.
const RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// Response bodies in failures, not just status codes. `seed invoice failed: 500`
// cost a CI round trip to diagnose because it did not say WHY.
async function expectOk(
  res: { ok(): boolean; status(): number; text(): Promise<string> },
  what: string,
) {
  if (res.ok()) return;
  const body = await res.text().catch(() => '');
  expect(res.ok(), `${what} failed (${res.status()}): ${body.slice(0, 300)}`).toBe(true);
}

test.beforeAll(async ({ request }) => {
  const { accountId, companyId } = workspace();
  const headers = {
    'content-type': 'application/json',
    origin: ORIGIN,
    cookie: cookieHeader(),
    'x-account-id': accountId,
  };

  const contact = await request.post(`${API}/api/contacts`, {
    headers,
    data: { companyId, name: 'Chart Fixture Ltd' },
  });
  await expectOk(contact, 'seed contact');
  const contactId = ((await contact.json()) as { id: string }).id;

  for (const [i, m] of MONTHS.entries()) {
    const created = await request.post(`${API}/api/invoices`, {
      headers,
      data: {
        companyId,
        contactId,
        number: `CHART-${RUN_ID}-${i}`,
        issueDate: m.issueDate,
        dueDate: m.issueDate,
        subtotal: m.total,
        total: m.total,
        lineItems: [
          {
            position: 1,
            description: 'Mowing',
            quantity: '1',
            unitPrice: m.total,
            amount: m.total,
            type: 'service',
          },
        ],
      },
    });
    await expectOk(created, 'seed invoice');
    const id = ((await created.json()) as { id: string }).id;
    // Issued, because the report counts sent and paid invoices only.
    const sent = await request.post(`${API}/api/invoices/${id}/mark-sent`, { headers, data: {} });
    await expectOk(sent, 'mark-sent');
  }

  // The minor customer, for the share assertion.
  const minor = await request.post(`${API}/api/contacts`, {
    headers,
    data: { companyId, name: MINOR.name },
  });
  await expectOk(minor, 'seed minor contact');
  const minorId = ((await minor.json()) as { id: string }).id;
  const minorInvoice = await request.post(`${API}/api/invoices`, {
    headers,
    data: {
      companyId,
      contactId: minorId,
      number: `CHART-${RUN_ID}-minor`,
      issueDate: MINOR.issueDate,
      dueDate: MINOR.issueDate,
      subtotal: MINOR.total,
      total: MINOR.total,
      lineItems: [
        {
          position: 1,
          description: 'Mowing',
          quantity: '1',
          unitPrice: MINOR.total,
          amount: MINOR.total,
          type: 'service',
        },
      ],
    },
  });
  await expectOk(minorInvoice, 'seed minor invoice');
  const minorId2 = ((await minorInvoice.json()) as { id: string }).id;
  await expectOk(
    await request.post(`${API}/api/invoices/${minorId2}/mark-sent`, { headers, data: {} }),
    'mark-sent minor',
  );
});

const REPORT = '/reports/revenue-over-time?from=2026-01-01&to=2026-12-31';

test.describe('the chart module', () => {
  test('draws bars and an accessible table of the same series', async ({ page }) => {
    await page.goto(REPORT);

    const figure = page.locator('figure').first();
    await expect(figure).toBeVisible();

    // One rect per month with revenue. The seeded pair must be among them, and
    // the taller of the two is April — a bar chart that draws the wrong one
    // tallest is the failure this catches and a snapshot would not explain.
    const bars = figure.locator('svg rect');
    expect(await bars.count()).toBeGreaterThanOrEqual(2);

    // The accessible table is the screen-reader representation AND the no-JS
    // chart, so it has to carry real values rather than exist as an empty
    // shell.
    //
    // Asserted WITHOUT depending on exact totals. An earlier version expected
    // "$1,200.00" and broke the moment the same account was seeded twice — the
    // amounts had summed. A test that only passes against a pristine database
    // is a test that will lie to somebody eventually, so what is checked here
    // is the series' SHAPE: a row per month of the window, the seeded months
    // carrying real money, and one gap-filled month proving zeros survive as
    // zeros rather than vanishing.
    const table = figure.locator('table');
    await expect(table.locator('caption')).toContainText('Revenue by month');
    // Jan–Dec: the window is fixed, so the row count is too.
    await expect(table.locator('tbody tr')).toHaveCount(12);

    const money = /\$[\d,]+\.\d{2}/;
    // March and April were seeded, so both must show real money whatever else
    // the account holds. The tick also proves the month label is human — a raw
    // '2026-03' here would fail the every-page CI rule on this very page.
    await expect(table.locator('tbody tr', { hasText: 'Mar' }).first()).toHaveText(money);
    await expect(table.locator('tbody tr', { hasText: 'Apr' }).first()).toHaveText(money);
    // Nothing was seeded in November. formatValue must render the gap-filled
    // zero as $0.00 — never the em dash, which means "unknown".
    await expect(table.locator('tbody tr', { hasText: 'Nov' }).first()).toContainText('$0.00');
  });

  // THE test that chose the library. LayerChart could not be made to work on
  // this repo's Tailwind 3 at all; the alternative had to prove it renders
  // real geometry on the server, not just after hydration.
  test.describe('with JavaScript disabled', () => {
    test.use({ javaScriptEnabled: false });

    test('the chart and its table are still on the page', async ({ page }) => {
      await page.goto(REPORT);

      const figure = page.locator('figure').first();
      const bars = figure.locator('svg rect');
      expect(
        await bars.count(),
        'no server-rendered marks — the chart needs JS to exist',
      ).toBeGreaterThanOrEqual(2);

      // Same account-independent shape check as above: the full twelve rows,
      // server-rendered, with real money in a seeded month.
      const table = figure.locator('table');
      await expect(table.locator('tbody tr')).toHaveCount(12);
      await expect(table.locator('tbody tr', { hasText: 'Apr' }).first()).toHaveText(
        /\$[\d,]+\.\d{2}/,
      );
    });
  });

  test('a share bar renders the fraction, not the percentage', async ({ page }) => {
    await page.goto('/reports/sales-by-customer?from=2026-01-01&to=2026-12-31');

    // ShareBar takes 0..1 and CLAMPS. So a call site that forgot to divide by
    // 100 renders exactly "100%" — which means asserting 100% would have been
    // asserting the bug's own signature, and would pass on any account with a
    // single customer. The first version of this test did exactly that and
    // passed for the wrong reason.
    //
    // Instead: the deliberately tiny customer, whose share is a rounding error
    // of the total. It reads a small number when the conversion is right and
    // 100% when it is not, and it stays true however much other data the
    // account happens to carry.
    // .first(), because a re-run against the same account seeds another
    // customer of the same name and Playwright's strict mode then refuses an
    // ambiguous locator. Any one of them proves the conversion.
    const row = page.locator('tr', { hasText: MINOR.name }).first();
    await expect(row).toBeVisible();
    await expect(row).not.toContainText('100%');
    // And something percentage-shaped really is rendered, so the assertion
    // above cannot pass merely because the bar failed to draw at all.
    await expect(row).toContainText('%');
  });
});

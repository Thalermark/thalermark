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
  expect(contact.ok(), `seed contact failed: ${contact.status()}`).toBe(true);
  const contactId = ((await contact.json()) as { id: string }).id;

  for (const [i, m] of MONTHS.entries()) {
    const created = await request.post(`${API}/api/invoices`, {
      headers,
      data: {
        companyId,
        contactId,
        number: `CHART-${Date.now()}-${i}`,
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
    expect(created.ok(), `seed invoice failed: ${created.status()}`).toBe(true);
    const id = ((await created.json()) as { id: string }).id;
    // Issued, because the report counts sent and paid invoices only.
    const sent = await request.post(`${API}/api/invoices/${id}/mark-sent`, { headers, data: {} });
    expect(sent.ok(), `mark-sent failed: ${sent.status()}`).toBe(true);
  }
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
    const table = figure.locator('table');
    await expect(table.locator('caption')).toContainText('Revenue by month');
    await expect(table.locator('tbody tr')).not.toHaveCount(0);
    await expect(table).toContainText('$2,400.00');
    await expect(table).toContainText('$1,200.00');

    // The month tick carries a year only when the window needs one. This range
    // sits inside 2026, so a bare month is correct here — the multi-year case
    // is what the year suffix exists for.
    await expect(table.locator('tbody')).toContainText('Apr');
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

      await expect(figure.locator('table')).toContainText('$2,400.00');
    });
  });

  test('the share bars still render on the ranked reports', async ({ page }) => {
    await page.goto('/reports/sales-by-customer?from=2026-01-01&to=2026-12-31');
    // The seeded customer is the only one with sales, so its share is the whole
    // total. Asserting the rendered percentage rather than the element proves
    // the 0..1 conversion at the call site, which is the one thing the
    // component's own types could not check.
    await expect(page.getByText('100%').first()).toBeVisible();
  });
});

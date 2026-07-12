import { serverApiClient } from '$lib/api.server';
import { entityRowsToCsv } from '$lib/export';
import { EXPORT_COLUMNS, rowsToCsv } from '$lib/export/columns';
import { entityByKey } from '$lib/import/descriptors';
import { error } from '@sveltejs/kit';
import { strToU8, zipSync } from 'fflate';
import type { RequestHandler } from './$types';

// GET /settings/export/download?format=csv|json — the whole-account data export.
// Calls the reports:export-gated /api/account/export (403 flows straight through
// for a member who forges the URL), then assembles a ZIP with fflate: a root
// manifest.json (account + full company profiles) and one folder per company
// holding that company's records. CSV (default) reuses the import descriptors
// for contacts/items so they round-trip through Import, and the export column
// specs for everything else; JSON writes one file per entity with line items
// nested. Empty entities still emit a header-only CSV / `[]` JSON.
//
// zipSync is synchronous — fine at beta scale (data-only, no receipt binaries);
// if accounts grow large this is the seam to move to a background job.

type Row = Record<string, unknown>;

function sanitizeFolder(name: string): string {
  // Keep the name readable; only neutralize path separators, then strip a
  // trailing dot/space (illegal on Windows) and fall back for an empty name.
  const cleaned = name.replace(/[/\\]+/g, '-').trim();
  return cleaned.replace(/[.\s]+$/, '') || 'company';
}

export const GET: RequestHandler = async (event) => {
  const format = event.url.searchParams.get('format') === 'json' ? 'json' : 'csv';
  const client = serverApiClient(event);
  const res = await client.api.account.export.$get();
  if (!res.ok) throw error(res.status, 'failed to build export');
  const bundle = await res.json();

  const files: Record<string, Uint8Array> = {};
  const addText = (path: string, text: string) => {
    files[path] = strToU8(text);
  };

  addText(
    'manifest.json',
    JSON.stringify(
      {
        version: bundle.version,
        exportedAt: bundle.exportedAt,
        account: bundle.account,
        companies: bundle.companies.map((c) => c.company),
      },
      null,
      2,
    ),
  );

  // Dedupe folder names so two companies sharing a name don't collide.
  const usedFolders = new Map<string, number>();
  for (const co of bundle.companies) {
    let dir = sanitizeFolder(co.company.name);
    const seen = usedFolders.get(dir) ?? 0;
    usedFolders.set(dir, seen + 1);
    if (seen > 0) dir = `${dir} (${seen + 1})`;

    if (format === 'json') {
      const json = (name: string, value: unknown) =>
        addText(`${dir}/${name}.json`, JSON.stringify(value, null, 2));
      json('contacts', co.contacts);
      json('items', co.items);
      json('invoices', co.invoices);
      json('estimates', co.estimates);
      json('recurring-invoices', co.recurringInvoices);
      json('expenses', co.expenses);
      json('bills', co.bills);
      json('big-purchases', co.capitalPurchases);
      json('owner-money', co.ownerMoney);
      json('tax-policies', co.taxPolicies);
      continue;
    }

    // CSV path. Contacts + items reuse the import descriptors (round-trip); items
    // derive the descriptor's `archived` boolean from archivedAt, matching the
    // per-list items export.
    const itemRows = co.items.map((it) => ({ ...it, archived: it.archivedAt != null }));
    const csv = (name: string, text: string) => addText(`${dir}/${name}`, text);
    csv('contacts.csv', entityRowsToCsv(entityByKey('contacts'), co.contacts as Row[]));
    csv('items.csv', entityRowsToCsv(entityByKey('items'), itemRows as Row[]));
    csv(
      EXPORT_COLUMNS.invoices.file,
      rowsToCsv(EXPORT_COLUMNS.invoices.columns, co.invoices as Row[]),
    );
    csv(
      EXPORT_COLUMNS.invoiceLines.file,
      rowsToCsv(EXPORT_COLUMNS.invoiceLines.columns, co.invoices.flatMap((i) => i.lines) as Row[]),
    );
    csv(
      EXPORT_COLUMNS.estimates.file,
      rowsToCsv(EXPORT_COLUMNS.estimates.columns, co.estimates as Row[]),
    );
    csv(
      EXPORT_COLUMNS.estimateLines.file,
      rowsToCsv(
        EXPORT_COLUMNS.estimateLines.columns,
        co.estimates.flatMap((e) => e.lines) as Row[],
      ),
    );
    csv(
      EXPORT_COLUMNS.recurringInvoices.file,
      rowsToCsv(EXPORT_COLUMNS.recurringInvoices.columns, co.recurringInvoices as Row[]),
    );
    csv(
      EXPORT_COLUMNS.recurringLines.file,
      rowsToCsv(
        EXPORT_COLUMNS.recurringLines.columns,
        co.recurringInvoices.flatMap((r) => r.lines) as Row[],
      ),
    );
    csv(
      EXPORT_COLUMNS.expenses.file,
      rowsToCsv(EXPORT_COLUMNS.expenses.columns, co.expenses as Row[]),
    );
    csv(EXPORT_COLUMNS.bills.file, rowsToCsv(EXPORT_COLUMNS.bills.columns, co.bills as Row[]));
    csv(
      EXPORT_COLUMNS.capitalPurchases.file,
      rowsToCsv(EXPORT_COLUMNS.capitalPurchases.columns, co.capitalPurchases as Row[]),
    );
    csv(
      EXPORT_COLUMNS.ownerMoney.file,
      rowsToCsv(EXPORT_COLUMNS.ownerMoney.columns, co.ownerMoney as Row[]),
    );
    csv(
      EXPORT_COLUMNS.taxPolicies.file,
      rowsToCsv(EXPORT_COLUMNS.taxPolicies.columns, co.taxPolicies as Row[]),
    );
  }

  const zipped = zipSync(files, { level: 6 });
  const date = new Date().toISOString().slice(0, 10);
  return new Response(zipped, {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="thalermark-export-${date}.zip"`,
    },
  });
};

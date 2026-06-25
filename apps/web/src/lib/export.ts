import { type CsvCell, toCsv } from '$lib/csv';
import type { ImportEntity, ImportField } from '$lib/import/descriptors';

// Pure CSV-export helpers (no SvelteKit/env imports) so they're unit-testable.
// The server shell that resolves the company and pages the API lives in
// export.server.ts. Export is the inverse of import: columns are the import
// field labels and each cell is shaped so the importer's `coerce` reverses it,
// so an exported CSV re-imports cleanly (export → edit in a spreadsheet →
// re-import). The round-trip guard test in descriptors.test.ts proves the
// headers auto-map back to their fields.

// One row value → a CSV cell. Money + quantity arrive as decimal strings on the
// wire, so they pass through as-is (the import `money`/`quantity` coerce strips
// any `$`/commas a user later adds). taxable → "yes"/"no" (import `boolish`
// reads both); null/undefined → "" (never the literal "null").
export function formatCell(field: ImportField, value: unknown): CsvCell {
  if (value === null || value === undefined) return '';
  if (field.key === 'taxable') return value ? 'yes' : 'no';
  return String(value);
}

// Header row (field labels) + one row per record, serialized with the shared
// RFC-4180 writer so the file reads identically to the ledger export.
export function entityRowsToCsv(entity: ImportEntity, rows: Record<string, unknown>[]): string {
  const header = entity.fields.map((f) => f.label);
  const body = rows.map((r) => entity.fields.map((f) => formatCell(f, r[f.key])));
  return toCsv([header, ...body]);
}

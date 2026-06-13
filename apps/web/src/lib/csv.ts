// Client-side CSV builder + browser download for the report pages. Reports
// load their full data (no pagination), so the rows are already in the page —
// building the CSV in the browser keeps export off the API surface and needs no
// extra capability: any role that can see a report can save what's on screen.
// The GL/ledger export stays reports:export-gated because it carries journal
// detail the freelancer never sees on a normal report page.

export type CsvCell = string | number | null | undefined;

// RFC 4180 cell escaping — same rule as the server-side ledger export so the
// two CSVs read identically. Quote a cell that holds a comma, quote, or
// newline; double any embedded quote.
function escapeCell(value: CsvCell): string {
  const s = value == null ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// First row is the header. LF line endings + a trailing newline, matching the
// ledger export.
export function toCsv(rows: CsvCell[][]): string {
  return `${rows.map((r) => r.map(escapeCell).join(',')).join('\n')}\n`;
}

// Trigger a browser download of `rows` as a CSV file. No-op on the server (the
// reports SSR-render, but this only ever runs from a click handler in the
// browser). Appends a `.csv` extension if the caller omits one.
export function downloadCsv(filename: string, rows: CsvCell[][]): void {
  if (typeof document === 'undefined') return;
  const name = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

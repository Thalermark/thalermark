import { type CsvCell, toCsv } from '$lib/csv';
import { formatCell } from '$lib/export';

// Per-entity export column specs for the full-account "Export my data" ZIP (CSV
// path). One spec per business entity in the /api/account/export bundle; each
// picks the user-meaningful columns in a readable order and gives them friendly
// headers. Rows arrive from the API already JSON-serialized (money/dates are
// strings, timestamps ISO), so formatCell renders every cell without extra
// coercion — money passes through, booleans become yes/no, null becomes "".
//
// Contacts and items are NOT here: they reuse the import descriptors
// ($lib/import/descriptors via entityRowsToCsv) so their CSVs round-trip back
// through Settings → Import. Everything below is export-only.
//
// The `id` column is kept last on each entity for traceability, and header
// entities that own line items (invoices/estimates/recurring) carry their id so
// the matching *-lines file joins back to them.

export type ExportColumn = { key: string; label: string };
export type EntitySpec = { file: string; columns: ExportColumn[] };

// Header + one row per record → CSV, via the shared RFC-4180 writer. Generic
// sibling of entityRowsToCsv (which is descriptor-driven for import round-trip).
export function rowsToCsv(columns: ExportColumn[], rows: Record<string, unknown>[]): string {
  const header: CsvCell[] = columns.map((c) => c.label);
  const body = rows.map((r) => columns.map((c) => formatCell(r[c.key])));
  return toCsv([header, ...body]);
}

const lineColumns = (parentKey: string, parentLabel: string): ExportColumn[] => [
  { key: parentKey, label: parentLabel },
  { key: 'position', label: 'Line #' },
  { key: 'description', label: 'Description' },
  { key: 'quantity', label: 'Quantity' },
  { key: 'unitPrice', label: 'Unit Price' },
  { key: 'amount', label: 'Amount' },
  { key: 'type', label: 'Type' },
  { key: 'taxable', label: 'Taxable' },
  { key: 'taxRatePct', label: 'Tax Rate %' },
  { key: 'taxAmount', label: 'Tax Amount' },
];

export const EXPORT_COLUMNS = {
  invoices: {
    file: 'invoices.csv',
    columns: [
      { key: 'number', label: 'Invoice #' },
      { key: 'status', label: 'Status' },
      { key: 'contactName', label: 'Customer' },
      { key: 'issueDate', label: 'Issue Date' },
      { key: 'dueDate', label: 'Due Date' },
      { key: 'currency', label: 'Currency' },
      { key: 'subtotal', label: 'Subtotal' },
      { key: 'tax', label: 'Tax' },
      { key: 'total', label: 'Total' },
      { key: 'paymentMethod', label: 'Payment Method' },
      { key: 'paymentReference', label: 'Payment Reference' },
      { key: 'notes', label: 'Notes' },
      { key: 'sentAt', label: 'Sent At' },
      { key: 'paidAt', label: 'Paid At' },
      { key: 'voidedAt', label: 'Voided At' },
      { key: 'createdAt', label: 'Created At' },
      { key: 'id', label: 'Invoice ID' },
    ],
  },
  invoiceLines: { file: 'invoice-lines.csv', columns: lineColumns('invoiceId', 'Invoice ID') },
  estimates: {
    file: 'estimates.csv',
    columns: [
      { key: 'number', label: 'Estimate #' },
      { key: 'status', label: 'Status' },
      { key: 'contactName', label: 'Customer' },
      { key: 'issueDate', label: 'Issue Date' },
      { key: 'expiresOn', label: 'Expires On' },
      { key: 'currency', label: 'Currency' },
      { key: 'subtotal', label: 'Subtotal' },
      { key: 'tax', label: 'Tax' },
      { key: 'total', label: 'Total' },
      { key: 'notes', label: 'Notes' },
      { key: 'sentAt', label: 'Sent At' },
      { key: 'acceptedAt', label: 'Accepted At' },
      { key: 'declinedAt', label: 'Declined At' },
      { key: 'expiredAt', label: 'Expired At' },
      { key: 'createdAt', label: 'Created At' },
      { key: 'id', label: 'Estimate ID' },
    ],
  },
  estimateLines: { file: 'estimate-lines.csv', columns: lineColumns('estimateId', 'Estimate ID') },
  recurringInvoices: {
    file: 'recurring-invoices.csv',
    columns: [
      { key: 'contactName', label: 'Customer' },
      { key: 'status', label: 'Status' },
      { key: 'frequency', label: 'Frequency' },
      { key: 'intervalCount', label: 'Every' },
      { key: 'startDate', label: 'Start Date' },
      { key: 'nextRunDate', label: 'Next Run' },
      { key: 'endDate', label: 'End Date' },
      { key: 'maxOccurrences', label: 'Max Occurrences' },
      { key: 'occurrenceCount', label: 'Occurrences So Far' },
      { key: 'netTermsDays', label: 'Net Terms (days)' },
      { key: 'currency', label: 'Currency' },
      { key: 'subtotal', label: 'Subtotal' },
      { key: 'tax', label: 'Tax' },
      { key: 'total', label: 'Total' },
      { key: 'notes', label: 'Notes' },
      { key: 'createdAt', label: 'Created At' },
      { key: 'id', label: 'Recurring ID' },
    ],
  },
  recurringLines: {
    file: 'recurring-invoice-lines.csv',
    columns: lineColumns('recurringInvoiceId', 'Recurring ID'),
  },
  expenses: {
    file: 'expenses.csv',
    columns: [
      { key: 'expenseDate', label: 'Date' },
      { key: 'merchant', label: 'Merchant' },
      { key: 'vendorName', label: 'Vendor' },
      { key: 'customerName', label: 'Billed To' },
      { key: 'categoryName', label: 'Category' },
      { key: 'paymentName', label: 'Paid From' },
      { key: 'amount', label: 'Amount' },
      { key: 'memo', label: 'Memo' },
      { key: 'receiptStorageKey', label: 'Receipt' },
      { key: 'createdAt', label: 'Created At' },
      { key: 'id', label: 'Expense ID' },
    ],
  },
  bills: {
    file: 'bills.csv',
    columns: [
      { key: 'billDate', label: 'Date' },
      { key: 'vendorName', label: 'Vendor' },
      { key: 'reference', label: 'Reference' },
      { key: 'categoryName', label: 'Category' },
      { key: 'paymentName', label: 'Paid From' },
      { key: 'amount', label: 'Amount' },
      { key: 'currency', label: 'Currency' },
      { key: 'dueDate', label: 'Due Date' },
      { key: 'status', label: 'Status' },
      { key: 'paymentMethod', label: 'Payment Method' },
      { key: 'paymentReference', label: 'Payment Reference' },
      { key: 'memo', label: 'Memo' },
      { key: 'createdAt', label: 'Created At' },
      { key: 'id', label: 'Bill ID' },
    ],
  },
  capitalPurchases: {
    file: 'big-purchases.csv',
    columns: [
      { key: 'description', label: 'Description' },
      { key: 'purchaseDate', label: 'Date' },
      { key: 'vendorName', label: 'Vendor' },
      { key: 'amount', label: 'Amount' },
      { key: 'funding', label: 'Funding' },
      { key: 'downPayment', label: 'Down Payment' },
      { key: 'taxTreatment', label: 'Tax Treatment' },
      { key: 'usefulLifeYears', label: 'Useful Life (years)' },
      { key: 'memo', label: 'Memo' },
      { key: 'createdAt', label: 'Created At' },
      { key: 'id', label: 'Purchase ID' },
    ],
  },
  ownerMoney: {
    file: 'owner-money.csv',
    columns: [
      { key: 'occurredOn', label: 'Date' },
      { key: 'kind', label: 'Type' },
      { key: 'amount', label: 'Amount' },
      { key: 'memo', label: 'Memo' },
      { key: 'createdAt', label: 'Created At' },
      { key: 'id', label: 'Entry ID' },
    ],
  },
  taxPolicies: {
    file: 'tax-policies.csv',
    columns: [
      { key: 'name', label: 'Name' },
      { key: 'ratePct', label: 'Rate %' },
      { key: 'isDefault', label: 'Default' },
      { key: 'archivedAt', label: 'Archived At' },
      { key: 'createdAt', label: 'Created At' },
      { key: 'id', label: 'Policy ID' },
    ],
  },
} satisfies Record<string, EntitySpec>;

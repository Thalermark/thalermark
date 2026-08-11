// The words the activity feed speaks (TMC-245).
//
// Extracted out of AuditHistory.svelte because it stopped being a lookup table
// and became logic: which fields are the user's, which are the schema's, and how
// a stored value reads to someone who has never seen the database. That logic
// shipped half-right once — field NAMES were humanised while their VALUES were
// still raw uuids — and only a manual pass caught it. It is unit-tested here so
// the next change to it does not depend on someone looking at the screen.

// Action → display verb.
//
// Every action the API can raise has an entry. The lookup still falls back to
// the raw string, but that is now a bug rather than a feature: an unmapped
// action means a new one shipped without copy, and it will read as
// `payment-recorded` on a screen where everything else is English.
export const ACTION_LABELS: Record<string, string> = {
  create: 'created',
  update: 'edited',
  'mark-sent': 'marked sent',
  'mark-paid': 'marked paid',
  'mark-accepted': 'marked accepted',
  'mark-declined': 'marked declined',
  void: 'voided',
  // TMC-227. "pulled back to fix" rather than "revised": the history tab has to
  // read as the sequence the operator lived through — pulled back, edited,
  // resent — and "revised" would collide with the "edited" row that follows it.
  revise: 'pulled back to fix',
  'email-sent': 'emailed',
  convert: 'converted to invoice',
  'stripe-paid': 'paid via Stripe',
  'stripe-connect-create': 'connected Stripe account',
  'stripe-connect-update': 'updated Stripe Connect status',
  'public-accept': 'accepted by recipient',
  'public-decline': 'declined by recipient',
  'receipt-upload': 'attached a receipt',
  'receipt-delete': 'removed the receipt',
  'receipt-extract': 'auto-filled from the receipt',
  'dismiss-review': 'dismissed the vendor review',
  pause: 'paused',
  resume: 'resumed',
  end: 'ended',
  archive: 'archived',
  restore: 'restored',
  delete: 'deleted',
  // Money moving against an invoice or a bill.
  'payment-recorded': 'recorded a payment',
  'payment-removed': 'removed a payment',
  'edit-payment': 'changed a payment',
  'deposit-taken': 'took a deposit',
  'reminders-opt-out': 'turned off reminders',
  // A capital purchase: its loan repayments, and the yearly write-off. The
  // write-off deliberately avoids the word "depreciation" — the purchase page
  // already says "about $600 in 2024", and that is the voice to match.
  payment: 'recorded a loan payment',
  depreciation: 'counted a year of this on taxes',
  // The business itself.
  retire: 'closed this business',
  unretire: 'reopened this business',
  'copy-from': 'copied settings from another business',
  'logo-upload': 'added a logo',
  'logo-remove': 'removed the logo',
  // The incorporation handoff. Direction is the whole point of the pair, so it
  // is named rather than left to the row's context.
  'handoff-out': 'handed the books to the new business',
  'handoff-in': 'took the books from the old business',
  'handoff-out-reversed': 'undid the handoff out',
  'handoff-in-reversed': 'undid the handoff in',
  // People and customers.
  'transfer-ownership': 'transferred ownership',
  'statement-emailed': 'emailed a statement',
  reset: 'reset to the default wording',
  // The accountant portal. "Reversed this entry" keeps the accounting word on
  // purpose: this action only ever appears inside The Ledger, whose audience is
  // the one that wants the term.
  reverse: 'reversed this entry',
  reopen: 'reopened the year',
};

// Entity-type → display singular for the feed prefix. Covers every type the
// API's feed will return (routes/audit-events.ts ALLOWED_TYPES), so none of them
// renders as raw snake_case.
export const ENTITY_LABELS: Record<string, string> = {
  contact: 'Contact',
  invoice: 'Invoice',
  estimate: 'Estimate',
  expense: 'Expense',
  bill: 'Bill',
  owner_money_event: 'Investment or withdrawal',
  capital_purchase: 'Big purchase',
  company: 'Company',
  recurring_invoice: 'Repeating invoice',
  item: 'Item',
  opening_balance: 'Starting balances',
  manual_adjustment: 'Ledger entry',
  period_close: 'Closed year',
  mileage_trip: 'Trip',
  vehicle: 'Vehicle',
};

// Only the types with a per-id page. A type missing here still gets its label —
// it just renders as text rather than a link, because "Starting balances" and a
// closed year have no page of their own and linking them would build a dead URL
// out of the entity id.
export const ENTITY_PATHS: Record<string, string> = {
  contact: '/contacts',
  invoice: '/invoices',
  estimate: '/estimates',
  expense: '/expenses',
  bill: '/bills',
  owner_money_event: '/owner-money',
  capital_purchase: '/purchases',
  company: '/settings/payments',
  recurring_invoice: '/recurring',
  item: '/items',
  manual_adjustment: '/ledger',
};

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

// Timestamps whose row already says what they mean: "marked sent" makes
// "sentAt: empty → 2026-05-27" clutter. Each one here has an ACTION_LABELS entry
// that conveys it. Anything not on this list is shown, so a stamp nothing else
// explains can't disappear from the diff (TMC-240).
const IMPLIED_STAMPS = new Set([
  'sentAt',
  'paidAt',
  'acceptedAt',
  'declinedAt',
  'voidedAt',
  'archivedAt',
  'receiptUploadedAt',
]);

// Column name → what the user calls it. Anything not named here falls back to
// splitting the camelCase, which turns `unitPrice` into "unit price" —
// imperfect for a word we never thought about, but never an identifier.
export const FIELD_LABELS: Record<string, string> = {
  deletedAt: 'deleted',
  archivedAt: 'archived',
  expenseDate: 'date',
  occurredOn: 'date',
  purchaseDate: 'date',
  issueDate: 'issued',
  dueDate: 'due',
  categoryAccountId: 'category',
  paymentAccountId: 'paid from',
  contactId: 'customer',
  vendorContactId: 'vendor',
  taxPolicyId: 'tax',
  businessType: 'business type',
  usefulLifeYears: 'spread over',
  taxTreatment: 'on taxes',
  downPayment: 'down payment',
  unitPrice: 'price',
  memo: 'note',
};

export function fieldLabel(key: string): string {
  const known = FIELD_LABELS[key];
  if (known) return known;
  return key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
}

// A stored timestamp is an ISO string over the wire. Showing the date is what
// the reader wants; the millisecond precision was never for them.
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v: unknown): boolean {
  return typeof v === 'string' && UUID.test(v);
}

// Columns that are plumbing, not content. `id` identifies the row the reader is
// already looking at; account and company are the tenancy keys and are the same
// on every row they will ever see. Rendering them leaked the schema onto a
// screen whose whole promise is that the schema stays hidden.
const INTERNAL_FIELDS = new Set(['id', 'accountId', 'companyId', 'publicToken']);

// Values are stringified with a short truncation so long strings stay readable
// in the row.
export function shortValue(v: unknown): string {
  if (v === null || v === undefined) return 'empty';
  if (typeof v === 'string') {
    if (ISO_TIMESTAMP.test(v)) return v.slice(0, 10);
    if (v.length > 24) return `${v.slice(0, 12)}…${v.slice(-4)}`;
    return v;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function sameDeep(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // null and undefined are the same absence to a reader — an optional column
  // that arrives as one on the way in and the other on the way out has not
  // changed. Spelled out rather than leaning on `==`, which only read as
  // deliberate while this lived in a .svelte file the linter skipped.
  if (a == null || b == null) return a == null && b == null;
  if (typeof a !== typeof b) return false;
  if (typeof a === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

// A small line of changed key fields between before and after. A creation has
// only `after`, so every field reads as "empty → value" — which is why the
// suppressions below matter most there.
export function diffLines(before: unknown, after: unknown): string[] {
  const lines: string[] = [];
  const b = isRecord(before) ? before : {};
  const a = isRecord(after) ? after : {};
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  // Line-item arrays bloat the row and the entity's own page already shows them.
  keys.delete('lineItems');
  // Same reason: a business-type change carries the chart-of-accounts re-map
  // result, which JSON-stringifies into an unreadable wall next to
  // "business type: sole_prop → s_corp". The full payload stays in the audit row.
  keys.delete('chartOfAccounts');
  // Bookkeeping columns the row itself already answers. `updatedAt` changes on
  // every single write, duplicates the timestamp shown at the end of the row,
  // and was the reason a delete used to render as "1 change: updatedAt" — a line
  // that says nothing while implying that is all that happened.
  keys.delete('updatedAt');
  keys.delete('createdAt');
  for (const k of keys) {
    if (INTERNAL_FIELDS.has(k)) continue;
    const bv = b[k];
    const av = a[k];
    if (sameDeep(bv, av)) continue;
    // A foreign key names something the reader knows by NAME — a category, a
    // customer, a payment account. The id is meaningless to them, and putting it
    // after a friendly label is worse than the raw column was: it reads as
    // though the uuid IS the category. The name cannot be resolved here (the
    // audit payload is a row snapshot, not a join), so say what is true and no
    // more. On a create there is nothing to say at all — "category: changed"
    // about a record being born is noise.
    if (isUuid(bv) || isUuid(av)) {
      if (bv != null && av != null) lines.push(`${fieldLabel(k)}: changed`);
      continue;
    }
    // Skip noise: a stamp the action label already carries.
    if (IMPLIED_STAMPS.has(k) && bv == null) continue;
    lines.push(`${fieldLabel(k)}: ${shortValue(bv)} → ${shortValue(av)}`);
  }
  return lines;
}

import { type Href, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

// Audit trail — the native mirror of apps/web's
// $lib/components/AuditHistory.svelte (slices 8.8a / 8.8b). Compact rows: actor
// + human-readable action + relative timestamp, with a tappable "N changes"
// disclosure showing computed before/after field deltas. Presentational only:
// the host screen fetches `GET /api/audit-events` and passes the events down.
//
// Two modes:
//   per-entity (default) — host filters by entityType+entityId; refreshes for
//     free after every in-screen mutation (mark-paid, void, convert, …).
//   feed (showEntity)    — the account-wide activity screen passes the
//     unfiltered feed; each row prefixes a tappable "Invoice INV-0042" that
//     navigates to the entity's detail screen.

export type AuditEvent = {
  id: string;
  action: string;
  actorName: string;
  createdAt: string;
  before: unknown;
  after: unknown;
  // Present in feed mode (the unfiltered /api/audit-events response). Ignored
  // in per-entity mode.
  entityType?: string;
  entityId?: string;
  entityLabel?: string | null;
};

// Action → display verb. Ported from web's $lib/audit-vocabulary.ts, which is
// the source this file has to track (TMC-270). Every action the API can raise
// needs an entry: the lookup still falls back to the raw string, but that is a
// bug rather than a feature. An unmapped action means one shipped without copy,
// and it reads as `payment-recorded` on a screen where everything else is
// English. That is exactly what had happened here, for 22 of the 46 verbs.
const ACTION_LABELS: Record<string, string> = {
  create: 'created',
  update: 'edited',
  'mark-sent': 'marked sent',
  'mark-paid': 'marked paid',
  'mark-accepted': 'marked accepted',
  'mark-declined': 'marked declined',
  void: 'voided',
  // TMC-227. "pulled back to fix" rather than "revised", so the history reads
  // as the sequence the operator lived through — pulled back, edited, resent.
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
  // write-off deliberately avoids the word "depreciation" because the purchase
  // page already says "about $600 in 2024", and that is the voice to match.
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

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

// Entity-type → display singular for the feed prefix. Kept in sync with web's
// ENTITY_LABELS.
const ENTITY_LABELS: Record<string, string> = {
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

// Column name → what the user calls it. Anything not named here falls back to
// splitting the camelCase, which turns `unitPrice` into "unit price":
// imperfect for a word we never thought about, but never an identifier.
const FIELD_LABELS: Record<string, string> = {
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

function fieldLabel(key: string): string {
  const known = FIELD_LABELS[key];
  if (known) return known;
  return key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
}

// Timestamps whose row already says what they mean: "marked sent" makes
// "sent: empty → 2026-05-27" clutter. Each one here has an ACTION_LABELS entry
// that conveys it. Anything not on this list is shown, so a stamp nothing else
// explains cannot disappear from the diff (TMC-240).
const IMPLIED_STAMPS = new Set([
  'sentAt',
  'paidAt',
  'acceptedAt',
  'declinedAt',
  'voidedAt',
  'archivedAt',
  'receiptUploadedAt',
]);

// Columns that are plumbing, not content. `id` identifies the row the reader is
// already looking at; account and company are the tenancy keys and are the same
// on every row they will ever see; `publicToken` is the capability string
// behind the public invoice view. Rendering them leaked the schema onto a
// screen whose whole promise is that the schema stays hidden.
const INTERNAL_FIELDS = new Set(['id', 'accountId', 'companyId', 'publicToken']);

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v: unknown): boolean {
  return typeof v === 'string' && UUID.test(v);
}

// Entity-type → detail-screen route. company has no detail screen on mobile, so
// it points at the business settings tab (its closest equivalent). A null
// return makes the prefix non-tappable.
function entityHref(entityType: string, entityId: string): Href | null {
  switch (entityType) {
    case 'contact':
      return `/contacts/${entityId}`;
    case 'invoice':
      return `/invoices/${entityId}`;
    case 'estimate':
      return `/estimates/${entityId}`;
    case 'expense':
      return `/expenses/${entityId}`;
    case 'bill':
      return `/bills/${entityId}`;
    case 'owner_money_event':
      return `/owner-money/${entityId}`;
    case 'recurring_invoice':
      return `/invoices/recurring/${entityId}`;
    case 'item':
      return `/more/items/${entityId}`;
    case 'capital_purchase':
      return `/purchases/${entityId}`;
    case 'manual_adjustment':
      return `/ledger/${entityId}`;
    case 'company':
      return '/more/business';
    // Starting balances, a closed year, a trip and a vehicle still get a label
    // above; they just have no per-id screen here, and linking them would build
    // a dead route out of the entity id.
    default:
      return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function sameDeep(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // null and undefined are the same absence to a reader. An optional column
  // that arrives as one on the way in and the other on the way out has not
  // changed.
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

// Short-form a value for the delta line — truncates long ids/tokens so the
// row stays readable.
function shortValue(v: unknown): string {
  // "empty", not a set-theory glyph. This row is read by someone who has never
  // seen the database and should not have to learn a symbol for "nothing".
  if (v === null || v === undefined) return 'empty';
  if (typeof v === 'string') {
    // A stored timestamp is an ISO string over the wire. The date is what the
    // reader wants; the millisecond precision was never for them.
    if (ISO_TIMESTAMP.test(v)) return v.slice(0, 10);
    if (v.length > 24) return `${v.slice(0, 12)}…${v.slice(-4)}`;
    return v;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// Computed before/after deltas. Skips unchanged keys, line-item arrays (the
// entity's own screen shows those), and null→timestamp noise implied by the
// action label.
function diffLines(before: unknown, after: unknown): string[] {
  const lines: string[] = [];
  const b = isRecord(before) ? before : {};
  const a = isRecord(after) ? after : {};
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  keys.delete('lineItems');
  // A business-type change carries the chart-of-accounts re-map result, which
  // stringifies into an unreadable wall next to the type change itself. Stays
  // in the stored audit row; just not in the summary line.
  keys.delete('chartOfAccounts');
  // Bookkeeping columns the row itself already answers. `updatedAt` changes on
  // every single write, duplicates the timestamp shown at the end of the row,
  // and was the reason a delete used to render as "1 change: updatedAt", a line
  // that says nothing while implying that is all that happened.
  keys.delete('updatedAt');
  keys.delete('createdAt');
  for (const k of keys) {
    if (INTERNAL_FIELDS.has(k)) continue;
    const bv = b[k];
    const av = a[k];
    if (sameDeep(bv, av)) continue;
    // A foreign key names something the reader knows by NAME: a category, a
    // customer, a payment account. The id is meaningless to them, and putting
    // it after a friendly label is worse than the raw column was, because it
    // reads as though the uuid IS the category. The name cannot be resolved
    // here (the audit payload is a row snapshot, not a join), so say what is
    // true and no more. On a create there is nothing to say at all.
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

// Coarse relative time — the absolute stamp is the title in web; here it's
// the same coarse scale. Avoids pulling in a date lib for one use site.
function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const sec = Math.round(ms / 1000);
  if (sec < 60) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? '' : 's'} ago`;
  const mo = Math.round(day / 30);
  if (mo < 12) return `${mo} mo ago`;
  const yr = Math.round(mo / 12);
  return `${yr} yr ago`;
}

// `showEntity` switches on feed mode: the per-entity sidebar passes a section
// header ("History"); the activity screen renders its own header and omits it.
export function AuditHistory({
  events,
  showEntity = false,
}: {
  events: AuditEvent[];
  showEntity?: boolean;
}) {
  return (
    <View className={showEntity ? '' : 'mt-12 border-t border-ink/10 pt-8'}>
      {showEntity ? null : (
        <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">History</Text>
      )}
      {events.length === 0 ? (
        <Text className={`text-sm text-ink-subtle ${showEntity ? '' : 'mt-3'}`}>
          No history yet.
        </Text>
      ) : (
        <View className={showEntity ? 'gap-3' : 'mt-4 gap-3'}>
          {events.map((ev) => (
            <AuditRow key={ev.id} event={ev} showEntity={showEntity} />
          ))}
        </View>
      )}
    </View>
  );
}

function AuditRow({ event, showEntity }: { event: AuditEvent; showEntity: boolean }) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const lines = diffLines(event.before, event.after);
  const href =
    showEntity && event.entityType && event.entityId
      ? entityHref(event.entityType, event.entityId)
      : null;
  return (
    <View className="rounded-sm border border-ink/10 bg-cream-warm px-4 py-3">
      <View className="flex-row items-start justify-between gap-x-4">
        <Text className="flex-1 text-sm text-ink">
          {showEntity && event.entityType ? (
            <>
              <Text
                onPress={href ? () => router.push(href) : undefined}
                className={`font-medium ${href ? 'text-gold-deep' : 'text-ink'}`}
              >
                {ENTITY_LABELS[event.entityType] ?? event.entityType}
                {event.entityLabel ? ` ${event.entityLabel}` : ''}
              </Text>
              {' — '}
            </>
          ) : null}
          <Text className="font-medium">{event.actorName}</Text> {actionLabel(event.action)}
        </Text>
        <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
          {formatRelative(event.createdAt)}
        </Text>
      </View>
      {lines.length > 0 ? (
        <View className="mt-1.5">
          <Pressable onPress={() => setExpanded((v) => !v)}>
            <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
              {expanded ? '▾ ' : '▸ '}
              {lines.length} change{lines.length === 1 ? '' : 's'}
            </Text>
          </Pressable>
          {expanded ? (
            <View className="mt-1.5 gap-0.5">
              {lines.map((line) => (
                <Text key={line} className="font-mono text-xs text-ink/55">
                  {line}
                </Text>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

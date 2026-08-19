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

// Action → display verb. Unmapped actions render as the raw string so a new
// label surfaces in the UI without a code change here. Kept in sync with the
// web component's ACTION_LABELS.
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
  company: 'Company',
  recurring_invoice: 'Repeating invoice',
  item: 'Item',
};

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
    case 'company':
      return '/more/business';
    default:
      return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function sameDeep(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
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
  if (v === null || v === undefined) return '∅';
  if (typeof v === 'string') {
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
  for (const k of keys) {
    const bv = b[k];
    const av = a[k];
    if (sameDeep(bv, av)) continue;
    if (/At$/.test(k) && bv == null) continue;
    lines.push(`${k}: ${shortValue(bv)} → ${shortValue(av)}`);
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
        <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">History</Text>
      )}
      {events.length === 0 ? (
        <Text className={`text-sm text-ink/50 ${showEntity ? '' : 'mt-3'}`}>No history yet.</Text>
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
        <Text className="font-mono text-xs uppercase tracking-widest text-ink/40">
          {formatRelative(event.createdAt)}
        </Text>
      </View>
      {lines.length > 0 ? (
        <View className="mt-1.5">
          <Pressable onPress={() => setExpanded((v) => !v)}>
            <Text className="font-mono text-xs uppercase tracking-widest text-ink/40">
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

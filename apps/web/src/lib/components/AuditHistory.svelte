<script lang="ts">
  // Per-entity + account-wide audit trail (slices 8.8a / 8.8b). Compact rows:
  // human-readable action + actor + relative timestamp + a small line of
  // before/after field deltas. Raw JSON was replaced by computed diffs in
  // 8.8b — operators don't want to read JSON, and the deltas carry enough
  // context for ordinary auditing. Feed mode adds an entity-link prefix
  // ("Invoice INV-0042") so account-wide rows are self-describing.

  type AuditEvent = {
    id: string;
    action: string;
    actorName: string;
    createdAt: string;
    before: unknown;
    after: unknown;
    // Present in feed mode (slice 8.8b). Per-entity mode (slice 8.8a) sends
    // them too but the consumer ignores them.
    entityType?: string;
    entityId?: string;
    entityLabel?: string | null;
  };

  type Props = { events: AuditEvent[]; showEntity?: boolean };
  let { events, showEntity = false }: Props = $props();

  // Action → display verb.
  //
  // Every action the API can raise has an entry (TMC-245). The lookup still
  // falls back to the raw string, but that is now a bug rather than a feature:
  // an unmapped action means a new one shipped without copy, and it will read
  // as `payment-recorded` on a screen where everything else is English.
  const ACTION_LABELS: Record<string, string> = {
    create: 'created',
    update: 'edited',
    'mark-sent': 'marked sent',
    'mark-paid': 'marked paid',
    'mark-accepted': 'marked accepted',
    'mark-declined': 'marked declined',
    void: 'voided',
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
    // The incorporation handoff. Direction is the whole point of the pair, so
    // it is named rather than left to the row's context.
    'handoff-out': 'handed the books to the new business',
    'handoff-in': 'took the books from the old business',
    'handoff-out-reversed': 'undid the handoff out',
    'handoff-in-reversed': 'undid the handoff in',
    // People and customers.
    'transfer-ownership': 'transferred ownership',
    'statement-emailed': 'emailed a statement',
    reset: 'reset to the default wording',
    // The accountant portal. "Reversed this entry" keeps the accounting word on
    // purpose: this action only ever appears inside The Ledger, whose audience
    // is the one that wants the term.
    reverse: 'reversed this entry',
    reopen: 'reopened the year',
  };

  // Entity-type → display singular for the feed prefix. Covers every type the
  // API's feed will return (routes/audit-events.ts ALLOWED_TYPES), so none of
  // them renders as raw snake_case.
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
  // Only the types with a per-id page. A type missing here still gets its label
  // — it just renders as text rather than a link, because "Starting balances"
  // and a closed year have no page of their own and linking them would build a
  // dead URL out of the entity id (TMC-245).
  const ENTITY_PATHS: Record<string, string> = {
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

  function actionLabel(action: string): string {
    return ACTION_LABELS[action] ?? action;
  }

  // Timestamps whose row already says what they mean: "marked sent" makes
  // "sentAt: ∅ → 2026-05-27T…" clutter. Each one here has an ACTION_LABELS
  // entry above that conveys it. Anything not on this list is shown, so a
  // stamp nothing else explains can't disappear from the diff.
  const IMPLIED_STAMPS = new Set([
    'sentAt',
    'paidAt',
    'acceptedAt',
    'declinedAt',
    'voidedAt',
    'archivedAt',
    'receiptUploadedAt',
  ]);

  // Column name → what the user calls it (TMC-245). Expanding a row used to
  // print the schema: "deletedAt: ∅ → 2026-08-10T13:11:06.943Z". Anything not
  // named here falls back to splitting the camelCase, which turns `unitPrice`
  // into "unit price" — imperfect for a word we never thought about, but never
  // an identifier.
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
    // camelCase → spaced words, lowercased. `vendorReview` reads as "vendor
    // review" rather than as a column.
    return key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  }

  // A stored timestamp is an ISO string over the wire. Showing the date is what
  // the reader wants; the millisecond precision was never for them.
  const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/;

  // Compute a small line of changed key fields between before and after.
  // Skips entries where both sides are equal, and where keys aren't in
  // both objects (a creation only has `after` — handled separately). Values
  // are stringified with a short truncation so long ids/tokens stay
  // readable in the row.
  function shortValue(v: unknown): string {
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

  function diffLines(before: unknown, after: unknown): string[] {
    const lines: string[] = [];
    const b = isRecord(before) ? before : {};
    const a = isRecord(after) ? after : {};
    const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
    // Skip line-item arrays in the diff — they bloat the row and the
    // entity's own page already shows them.
    keys.delete('lineItems');
    // Same reason: a business-type change carries the chart-of-accounts
    // re-map result (which accounts were added / renamed / kept), which
    // JSON-stringifies into an unreadable wall next to "businessType:
    // sole_prop → s_corp". The full payload stays in the audit row.
    keys.delete('chartOfAccounts');
    // Bookkeeping columns the row itself already answers. `updatedAt` changes on
    // every single write, duplicates the timestamp shown at the end of the row,
    // and was the reason a delete used to render as "1 change: updatedAt" — a
    // line that says nothing while implying that is all that happened (TMC-245).
    keys.delete('updatedAt');
    keys.delete('createdAt');
    for (const k of keys) {
      const bv = b[k];
      const av = a[k];
      if (sameDeep(bv, av)) continue;
      // Skip noise: a stamp the action label already carries. Named one by one
      // rather than matched on /At$/, because that pattern swallowed deletedAt
      // too — and a delete row that reads "1 change: updatedAt" hides the only
      // field that says what happened (TMC-240).
      if (IMPLIED_STAMPS.has(k) && bv == null) continue;
      lines.push(`${fieldLabel(k)}: ${shortValue(bv)} → ${shortValue(av)}`);
    }
    return lines;
  }

  function isRecord(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function sameDeep(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a == null || b == null) return a == b;
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

  // Relative-time formatter — coarse-grained on purpose; the absolute
  // timestamp is the second line so the operator has both. Avoids pulling
  // in a date-fns / dayjs dep for this single use site.
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

  function formatAbsolute(iso: string): string {
    const d = new Date(iso);
    return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}Z`;
  }
</script>

<section class="mt-12 border-t border-fg/10 pt-8">
  <h2 class="label">History</h2>
  {#if events.length === 0}
    <p class="mt-3 text-sm text-fg/50">No history yet.</p>
  {:else}
    <ol class="mt-4 space-y-3">
      {#each events as ev (ev.id)}
        {@const lines = diffLines(ev.before, ev.after)}
        <li class="rounded-sm border border-fg/10 bg-surface-2 px-4 py-3">
          <div class="flex flex-wrap items-baseline justify-between gap-x-4">
            <p class="text-sm text-fg">
              {#if showEntity && ev.entityType && ev.entityId}
                <!-- Linked only when the type has a page to land on. Without the
                     guard, a starting-balance or closed-year row built a URL out
                     of the entity id and 404'd (TMC-245). -->
                {#if ENTITY_PATHS[ev.entityType]}
                  <a
                    href="{ENTITY_PATHS[ev.entityType]}/{ev.entityId}"
                    class="font-medium text-fg hover:text-accent"
                  >
                    {ENTITY_LABELS[ev.entityType] ?? ev.entityType}
                    {ev.entityLabel ?? ''}
                  </a>
                {:else}
                  <span class="font-medium text-fg">
                    {ENTITY_LABELS[ev.entityType] ?? ev.entityType}
                    {ev.entityLabel ?? ''}
                  </span>
                {/if}
                —
              {/if}
              <span class="font-medium">{ev.actorName}</span>
              {actionLabel(ev.action)}
            </p>
            <p
              class="font-mono text-xs uppercase tracking-widest text-fg/40"
              title={formatAbsolute(ev.createdAt)}
            >
              {formatRelative(ev.createdAt)}
            </p>
          </div>
          {#if lines.length > 0}
            <details class="mt-1.5">
              <summary
                class="cursor-pointer list-none font-mono text-xs uppercase tracking-widest text-fg/40 hover:text-accent"
              >
                {lines.length} change{lines.length === 1 ? '' : 's'}
              </summary>
              <ul class="mt-1.5 space-y-0.5 font-mono text-xs text-fg/55">
                {#each lines as line, i (i)}
                  <li>{line}</li>
                {/each}
              </ul>
            </details>
          {/if}
        </li>
      {/each}
    </ol>
  {/if}
</section>

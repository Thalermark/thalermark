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

  // Action → display verb. Unmapped actions render as the raw string so a
  // new label shows up in the UI without needing a code change here.
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
  };

  // Entity-type → display singular for the feed prefix and the link path.
  const ENTITY_LABELS: Record<string, string> = {
    customer: 'Customer',
    invoice: 'Invoice',
    estimate: 'Estimate',
    expense: 'Expense',
    company: 'Company',
  };
  const ENTITY_PATHS: Record<string, string> = {
    customer: '/customers',
    invoice: '/invoices',
    estimate: '/estimates',
    expense: '/expenses',
    company: '/settings/payments',
  };

  function actionLabel(action: string): string {
    return ACTION_LABELS[action] ?? action;
  }

  // Compute a small line of changed key fields between before and after.
  // Skips entries where both sides are equal, and where keys aren't in
  // both objects (a creation only has `after` — handled separately). Values
  // are stringified with a short truncation so long ids/tokens stay
  // readable in the row.
  function shortValue(v: unknown): string {
    if (v === null || v === undefined) return '∅';
    if (typeof v === 'string') {
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
    for (const k of keys) {
      const bv = b[k];
      const av = a[k];
      if (sameDeep(bv, av)) continue;
      // Skip noise: timestamps in transition payloads are implied by the
      // action label; rendering "sentAt: ∅ → 2026-05-27..." next to
      // "marked sent" adds clutter without information.
      if (/At$/.test(k) && bv == null) continue;
      lines.push(`${k}: ${shortValue(bv)} → ${shortValue(av)}`);
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

<section class="mt-12 border-t border-ink/10 pt-8">
  <h2 class="font-mono text-xs uppercase tracking-widest text-ink/50">History</h2>
  {#if events.length === 0}
    <p class="mt-3 text-sm text-ink/50">No history yet.</p>
  {:else}
    <ol class="mt-4 space-y-3">
      {#each events as ev (ev.id)}
        {@const lines = diffLines(ev.before, ev.after)}
        <li class="rounded-sm border border-ink/10 bg-cream-warm px-4 py-3">
          <div class="flex flex-wrap items-baseline justify-between gap-x-4">
            <p class="text-sm text-ink">
              {#if showEntity && ev.entityType && ev.entityId}
                <a
                  href="{ENTITY_PATHS[ev.entityType] ?? '/'}/{ev.entityId}"
                  class="font-medium text-ink hover:text-gold-deep"
                >
                  {ENTITY_LABELS[ev.entityType] ?? ev.entityType}
                  {ev.entityLabel ?? ''}
                </a>
                —
              {/if}
              <span class="font-medium">{ev.actorName}</span>
              {actionLabel(ev.action)}
            </p>
            <p
              class="font-mono text-xs uppercase tracking-widest text-ink/40"
              title={formatAbsolute(ev.createdAt)}
            >
              {formatRelative(ev.createdAt)}
            </p>
          </div>
          {#if lines.length > 0}
            <details class="mt-1.5">
              <summary
                class="cursor-pointer list-none font-mono text-xs uppercase tracking-widest text-ink/40 hover:text-gold-deep"
              >
                {lines.length} change{lines.length === 1 ? '' : 's'}
              </summary>
              <ul class="mt-1.5 space-y-0.5 font-mono text-xs text-ink/55">
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

<script lang="ts">
  // Per-entity audit trail (slice 8.8a). Compact rows: human-readable action
  // + actor + relative timestamp. The raw before/after JSON sits behind a
  // per-row collapsible toggle so a curious operator can still see the diff
  // without it dominating the layout — pretty diffs deferred to a later pass.

  type AuditEvent = {
    id: string;
    action: string;
    actorName: string;
    createdAt: string;
    before: unknown;
    after: unknown;
  };

  type Props = { events: AuditEvent[] };
  let { events }: Props = $props();

  // Action → display verb. Anything unmapped renders as the raw action so a
  // new action label shows up in the UI without needing a code change here.
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
    'public-accept': 'accepted by recipient',
    'public-decline': 'declined by recipient',
  };

  function actionLabel(action: string): string {
    return ACTION_LABELS[action] ?? action;
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
        <li class="rounded-sm border border-ink/10 bg-cream-warm px-4 py-3">
          <div class="flex flex-wrap items-baseline justify-between gap-x-4">
            <p class="text-sm text-ink">
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
          {#if ev.before || ev.after}
            <details class="mt-2">
              <summary class="cursor-pointer font-mono text-xs uppercase tracking-widest text-ink/40 hover:text-gold-deep">
                Details
              </summary>
              <pre class="mt-2 overflow-x-auto rounded-sm bg-cream px-3 py-2 text-xs text-ink/70">{JSON.stringify({ before: ev.before, after: ev.after }, null, 2)}</pre>
            </details>
          {/if}
        </li>
      {/each}
    </ol>
  {/if}
</section>

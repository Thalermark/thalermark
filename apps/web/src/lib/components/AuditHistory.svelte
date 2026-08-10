<script lang="ts">
  import { ENTITY_LABELS, ENTITY_PATHS, actionLabel, diffLines } from '$lib/audit-vocabulary';

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

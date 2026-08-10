<script lang="ts">
  import AuditHistory from '$lib/components/AuditHistory.svelte';
  import ConfirmSubmit from '$lib/components/ConfirmSubmit.svelte';
  import { may } from '$lib/perms';
  import { sumMoney } from '@thalermark/validation';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const entry = $derived(data.entry);
  const date = $derived(entry.postedAt.slice(0, 10));

  // Reversing is the ledger:adjust cluster; only offered while the entry is
  // still live (an entry gets exactly one reversal).
  const canReverse = $derived(may(data.role, 'ledger:adjust') && !entry.reversed);

  const totalDebit = $derived(
    sumMoney(entry.lines.filter((l) => l.side === 'debit').map((l) => l.amount)),
  );
  const totalCredit = $derived(
    sumMoney(entry.lines.filter((l) => l.side === 'credit').map((l) => l.amount)),
  );
</script>

<a href="/ledger" class="eyebrow text-fg/60 hover:text-fg">← The Ledger</a>
<div class="mt-3 flex items-baseline justify-between gap-6">
  <h1 class="font-serif text-4xl font-light leading-none tracking-tight text-fg">
    Journal entry<span class="text-accent">.</span>
  </h1>
  {#if canReverse}
    <ConfirmSubmit
      action="?/reverse"
      label="Reverse"
      title="Reverse this entry?"
      confirmLabel="Reverse entry"
      triggerClass="rounded-sm border border-danger/30 px-3 py-1 font-mono text-xs uppercase tracking-widest text-danger/80 hover:border-danger hover:text-danger"
    >
      {#snippet body()}
        A balancing opposite entry is posted, cancelling this one out. Both stay on the record —
        nothing is erased — and this cannot be undone.
      {/snippet}
    </ConfirmSubmit>
  {/if}
</div>

{#if entry.reversed}
  <div class="mt-6 rounded-sm border border-fg/20 bg-surface-2 px-4 py-3 text-sm text-fg/70">
    This entry has been reversed — a balancing opposite entry was posted, so it no longer affects
    your books.
  </div>
{/if}

{#if form?.reverseError}
  <div class="mt-4 rounded-sm border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
    Could not reverse this entry: {form.reverseError}
  </div>
{/if}

<dl class="mt-8 grid grid-cols-1 gap-x-12 gap-y-6 sm:grid-cols-2">
  <div>
    <dt class="label">Date</dt>
    <dd class="mt-1 font-mono tabular-nums text-fg">{date}</dd>
  </div>
  <div class="sm:col-span-2">
    <dt class="label">Description</dt>
    <dd class="mt-1 whitespace-pre-wrap text-fg/80">{entry.memo ?? '—'}</dd>
  </div>
</dl>

<div class="mt-8 overflow-hidden rounded-sm border border-fg/10 bg-surface-2">
  <table class="w-full text-left text-sm">
    <thead class="bg-surface">
      <tr class="label">
        <th class="px-5 py-3">Account</th>
        <th class="px-5 py-3 text-right">Debit</th>
        <th class="px-5 py-3 text-right">Credit</th>
      </tr>
    </thead>
    <tbody class="divide-y divide-fg/10">
      {#each entry.lines as line (line.coaAccountId + line.side + line.amount)}
        <tr>
          <td class="px-5 py-3 text-fg">
            <span class="font-mono text-fg/60">{line.code}</span>
            {line.accountName}
          </td>
          <td class="px-5 py-3 text-right font-mono tabular-nums text-fg">
            {line.side === 'debit' ? line.amount : ''}
          </td>
          <td class="px-5 py-3 text-right font-mono tabular-nums text-fg">
            {line.side === 'credit' ? line.amount : ''}
          </td>
        </tr>
      {/each}
    </tbody>
    <tfoot class="border-t border-fg/15 bg-surface">
      <tr class="label">
        <td class="px-5 py-3 text-right">Totals</td>
        <td class="px-5 py-3 text-right font-mono tabular-nums text-fg">{totalDebit}</td>
        <td class="px-5 py-3 text-right font-mono tabular-nums text-fg">{totalCredit}</td>
      </tr>
    </tfoot>
  </table>
</div>

<AuditHistory events={data.auditEvents} />

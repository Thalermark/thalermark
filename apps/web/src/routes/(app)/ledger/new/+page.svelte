<script lang="ts">
  import { enhance } from '$app/forms';
  import { sumMoney } from '@thalermark/validation';
  import { untrack } from 'svelte';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();

  type Line = { coaAccountId: string; side: 'debit' | 'credit'; amount: string };

  // Re-seed from a failed submit (values.linesRaw), else start with one debit
  // and one credit row — the shape of "debit X, credit Y" an accountant dictates.
  function initialLines(): Line[] {
    const raw = (form?.values as { linesRaw?: string } | undefined)?.linesRaw;
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Line[];
        if (Array.isArray(parsed) && parsed.length >= 2) return parsed;
      } catch {
        // fall through to the blank pair
      }
    }
    return [
      { coaAccountId: '', side: 'debit', amount: '' },
      { coaAccountId: '', side: 'credit', amount: '' },
    ];
  }

  // Seed once from the failed-submit form / load data; untrack marks the read
  // as intentionally one-shot (the form is interactive state from here on).
  let lines = $state<Line[]>(untrack(() => initialLines()));
  let memo = $state(untrack(() => (form?.values as { memo?: string } | undefined)?.memo ?? ''));
  let postedOn = $state(
    untrack(() => (form?.values as { postedOn?: string } | undefined)?.postedOn || data.today),
  );

  // Group the accounts by type so the picker reads like a chart of accounts.
  const TYPE_ORDER = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;
  const TYPE_LABELS: Record<string, string> = {
    asset: 'Assets',
    liability: 'Liabilities',
    equity: 'Equity',
    revenue: 'Revenue',
    expense: 'Expenses',
  };
  const grouped = $derived(
    TYPE_ORDER.map((type) => ({
      label: TYPE_LABELS[type],
      accounts: data.accounts.filter((a) => a.accountType === type),
    })).filter((g) => g.accounts.length > 0),
  );

  // Live running balance — the SAME sumMoney the server validates with, so the
  // on-screen total is exactly what passes or fails. sumMoney reads blanks as
  // zero, so a half-typed row never throws.
  const totalDebit = $derived(
    sumMoney(lines.filter((l) => l.side === 'debit').map((l) => l.amount)),
  );
  const totalCredit = $derived(
    sumMoney(lines.filter((l) => l.side === 'credit').map((l) => l.amount)),
  );
  const difference = $derived((Number(totalDebit) - Number(totalCredit)).toFixed(2));
  const balanced = $derived(totalDebit === totalCredit && Number(totalDebit) > 0);
  const completeLines = $derived(
    lines.filter((l) => l.coaAccountId && Number(l.amount) > 0).length,
  );
  const canSubmit = $derived(balanced && completeLines >= 2);

  function addLine() {
    lines = [...lines, { coaAccountId: '', side: 'debit', amount: '' }];
  }
  function removeLine(i: number) {
    if (lines.length > 2) lines = lines.filter((_, idx) => idx !== i);
  }
</script>

<a href="/ledger" class="eyebrow text-fg/60 hover:text-fg">← The Ledger</a>
<h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-fg">
  New journal entry<span class="text-accent">.</span>
</h1>
<p class="mt-4 max-w-2xl text-sm text-fg/60">
  Enter the debits and credits exactly as your accountant gave them. Total debits must equal total
  credits before you can post.
</p>

{#if form?.formError}
  <div class="mt-6 rounded-sm border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
    {form.formError}
  </div>
{/if}

<form method="post" action="?/save" class="mt-8 space-y-6" use:enhance>
  <div class="grid grid-cols-1 gap-6 sm:grid-cols-2">
    <div>
      <label for="postedOn" class="label">Date<span class="text-accent">*</span></label>
      <input id="postedOn" name="postedOn" type="date" required bind:value={postedOn} class="field mt-1" />
    </div>
    <div>
      <label for="memo" class="label">Description<span class="text-accent">*</span></label>
      <input
        id="memo"
        name="memo"
        type="text"
        required
        maxlength="500"
        placeholder="e.g. 2026 depreciation per CPA"
        bind:value={memo}
        class="field mt-1"
      />
    </div>
  </div>

  <div>
    <span class="label">Lines<span class="text-accent">*</span></span>
    <div class="mt-2 overflow-hidden rounded-sm border border-fg/10">
      <table class="w-full text-left text-sm">
        <thead class="bg-surface">
          <tr class="label">
            <th class="px-4 py-2">Account</th>
            <th class="w-32 px-4 py-2">Side</th>
            <th class="w-40 px-4 py-2 text-right">Amount</th>
            <th class="w-10 px-4 py-2"></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-fg/10">
          {#each lines as line, i (i)}
            <tr>
              <td class="px-4 py-2">
                <select bind:value={line.coaAccountId} class="field w-full">
                  <option value="" disabled>Choose an account…</option>
                  {#each grouped as group (group.label)}
                    <optgroup label={group.label}>
                      {#each group.accounts as account (account.id)}
                        <option value={account.id}>{account.code} · {account.name}</option>
                      {/each}
                    </optgroup>
                  {/each}
                </select>
              </td>
              <td class="px-4 py-2">
                <select bind:value={line.side} class="field w-full">
                  <option value="debit">Debit</option>
                  <option value="credit">Credit</option>
                </select>
              </td>
              <td class="px-4 py-2">
                <input
                  type="text"
                  inputmode="decimal"
                  placeholder="0.00"
                  bind:value={line.amount}
                  class="field w-full text-right font-mono tabular-nums"
                />
              </td>
              <td class="px-4 py-2 text-center">
                {#if lines.length > 2}
                  <button
                    type="button"
                    onclick={() => removeLine(i)}
                    class="text-fg/40 hover:text-danger"
                    aria-label="Remove line"
                  >
                    ×
                  </button>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <button
      type="button"
      onclick={addLine}
      class="mt-2 font-mono text-xs uppercase tracking-widest text-accent hover:underline"
    >
      + Add line
    </button>
  </div>

  <!-- Balance summary. The submit stays disabled until debits == credits and at
       least two lines are filled in — the same rule the server enforces. -->
  <div class="flex items-center justify-between gap-4 rounded-sm border border-fg/10 bg-surface-2 px-5 py-4">
    <div class="flex gap-8 font-mono text-sm tabular-nums">
      <span class="text-fg/60">Debits <span class="text-fg">{totalDebit}</span></span>
      <span class="text-fg/60">Credits <span class="text-fg">{totalCredit}</span></span>
    </div>
    {#if balanced}
      <span class="font-mono text-xs uppercase tracking-widest text-success">Balanced</span>
    {:else}
      <span class="font-mono text-xs uppercase tracking-widest text-fg/50">
        Out of balance by {difference}
      </span>
    {/if}
  </div>

  <!-- Serialized lines for the form action (variable-length list). -->
  <input type="hidden" name="lines" value={JSON.stringify(lines)} />

  <div class="flex items-center gap-4">
    <button type="submit" class="btn" disabled={!canSubmit}>Post entry</button>
    <a href="/ledger" class="text-sm text-fg/60 hover:text-fg">Cancel</a>
  </div>
</form>

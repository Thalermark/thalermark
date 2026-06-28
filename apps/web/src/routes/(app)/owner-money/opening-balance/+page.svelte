<script lang="ts">
  import { enhance } from '$app/forms';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const current = $derived(data.current);
  const fieldErrors = $derived(form?.fieldErrors ?? {});

  function err(key: string): string | undefined {
    return (fieldErrors as Record<string, string>)[key];
  }
  // Seed each field from a failed submit, else the saved balance, else blank.
  function v(key: 'asOfDate' | 'cash' | 'receivables' | 'payables'): string {
    const submitted = (form?.values as Record<string, unknown> | undefined)?.[key];
    if (typeof submitted === 'string') return submitted;
    const saved = current as Record<string, unknown> | null;
    const val = saved?.[key];
    return typeof val === 'string' ? val : '';
  }
  const dateValue = $derived(v('asOfDate') || current?.asOfDate || data.today);
</script>

<a href="/owner-money" class="eyebrow text-fg/60 hover:text-fg">← My Money</a>
<h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-fg">
  Starting balances<span class="text-accent">.</span>
</h1>
<p class="mt-4 max-w-2xl text-sm text-fg/60">
  What your business already had when you started using Thalermark — so your numbers are right from
  day one. Fill in what applies; leave the rest blank.
</p>

{#if form?.formError}
  <div class="mt-6 rounded-sm border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
    {form.formError}
  </div>
{/if}

<form method="post" action="?/save" class="mt-8 space-y-6" use:enhance>
  <div>
    <label for="asOfDate" class="label">When did you start?<span class="text-accent">*</span></label>
    <input id="asOfDate" name="asOfDate" type="date" required value={dateValue} class="field mt-1" />
    {#if err('asOfDate')}
      <p class="mt-1 text-xs text-danger">{err('asOfDate')}</p>
    {/if}
  </div>

  <div>
    <label for="cash" class="label">Money in the bank</label>
    <p class="text-xs text-fg/50">How much was in the business account when you started.</p>
    <input
      id="cash"
      name="cash"
      type="text"
      inputmode="decimal"
      placeholder="0.00"
      value={v('cash')}
      class="mt-1 w-full rounded-sm border border-fg/15 bg-surface-2 px-3 py-2 font-mono tabular-nums text-fg focus:border-accent focus:outline-none"
    />
    {#if err('cash')}
      <p class="mt-1 text-xs text-danger">{err('cash')}</p>
    {/if}
  </div>

  <div>
    <label for="receivables" class="label">Money customers already owed you</label>
    <p class="text-xs text-fg/50">Unpaid work from before you started here.</p>
    <input
      id="receivables"
      name="receivables"
      type="text"
      inputmode="decimal"
      placeholder="0.00"
      value={v('receivables')}
      class="mt-1 w-full rounded-sm border border-fg/15 bg-surface-2 px-3 py-2 font-mono tabular-nums text-fg focus:border-accent focus:outline-none"
    />
  </div>

  <div>
    <label for="payables" class="label">Money you already owed</label>
    <p class="text-xs text-fg/50">Bills or suppliers you hadn't paid yet.</p>
    <input
      id="payables"
      name="payables"
      type="text"
      inputmode="decimal"
      placeholder="0.00"
      value={v('payables')}
      class="mt-1 w-full rounded-sm border border-fg/15 bg-surface-2 px-3 py-2 font-mono tabular-nums text-fg focus:border-accent focus:outline-none"
    />
  </div>

  <div class="flex items-center gap-4">
    <button type="submit" class="btn">Save</button>
    <a href="/owner-money" class="text-sm text-fg/60 hover:text-fg">Cancel</a>
  </div>
</form>

{#if current}
  <form method="post" action="?/clear" class="mt-8 border-t border-fg/10 pt-6" use:enhance>
    <p class="text-sm text-fg/60">
      Clear your starting balances if you entered them by mistake. This removes them from your books.
    </p>
    <button
      type="submit"
      class="mt-3 rounded-sm border border-danger/30 px-3 py-1 font-mono text-xs uppercase tracking-widest text-danger/80 hover:border-danger hover:text-danger"
    >
      Clear starting balances
    </button>
  </form>
{/if}

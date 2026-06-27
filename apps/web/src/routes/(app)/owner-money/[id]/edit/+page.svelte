<script lang="ts">
  import { enhance } from '$app/forms';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const e = $derived(data.event);
  const values = $derived(form?.values ?? {});
  const fieldErrors = $derived(form?.fieldErrors ?? {});

  type FieldKey = 'kind' | 'amount' | 'occurredOn' | 'memo';
  // Priority: a submitted value (the user just edited it, via a fail()
  // re-render) wins; otherwise seed from the saved record.
  function v(key: FieldKey, saved: string): string {
    const submitted = (values as Record<string, unknown>)[key];
    return typeof submitted === 'string' ? submitted : saved;
  }
  function err(key: FieldKey): string | undefined {
    return (fieldErrors as Record<string, string>)[key];
  }

  const kindValue = $derived(v('kind', e.kind));
  const amountValue = $derived(v('amount', e.amount));
  const dateValue = $derived(v('occurredOn', e.occurredOn));
  const memoValue = $derived(v('memo', e.memo ?? ''));
</script>

<a href="/owner-money/{e.id}" class="eyebrow text-fg/60 hover:text-fg">← Back</a>
<h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-fg">
  Edit<span class="text-accent">.</span>
</h1>

{#if form?.formError}
  <div class="mt-6 rounded-sm border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
    {form.formError}
  </div>
{/if}

<form method="post" action="?/save" class="mt-8 space-y-6" use:enhance>
  <fieldset>
    <span class="label">What happened?<span class="text-accent">*</span></span>
    <div class="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
      <label
        class="flex cursor-pointer flex-col gap-1 rounded-sm border border-fg/15 bg-surface-2 px-4 py-3 hover:border-accent has-[:checked]:border-accent has-[:checked]:bg-accent/5"
      >
        <span class="flex items-center gap-2">
          <input type="radio" name="kind" value="contribution" checked={kindValue === 'contribution'} class="text-accent focus:ring-accent" />
          <span class="font-serif text-fg">I put my own money in</span>
        </span>
        <span class="pl-6 text-xs text-fg/55">Money you added to the business from your own pocket.</span>
      </label>
      <label
        class="flex cursor-pointer flex-col gap-1 rounded-sm border border-fg/15 bg-surface-2 px-4 py-3 hover:border-accent has-[:checked]:border-accent has-[:checked]:bg-accent/5"
      >
        <span class="flex items-center gap-2">
          <input type="radio" name="kind" value="draw" checked={kindValue === 'draw'} class="text-accent focus:ring-accent" />
          <span class="font-serif text-fg">I paid myself / took money out</span>
        </span>
        <span class="pl-6 text-xs text-fg/55">Money you took out of the business for yourself.</span>
      </label>
    </div>
    {#if err('kind')}
      <p class="mt-1 text-xs text-danger">{err('kind')}</p>
    {/if}
  </fieldset>

  <div class="grid grid-cols-1 gap-6 sm:grid-cols-2">
    <div>
      <label for="amount" class="label">Amount<span class="text-accent">*</span></label>
      <input
        id="amount"
        name="amount"
        type="text"
        inputmode="decimal"
        required
        placeholder="0.00"
        value={amountValue}
        class="mt-1 w-full rounded-sm border border-fg/15 bg-surface-2 px-3 py-2 font-mono tabular-nums text-fg focus:border-accent focus:outline-none"
      />
      {#if err('amount')}
        <p class="mt-1 text-xs text-danger">{err('amount')}</p>
      {/if}
    </div>
    <div>
      <label for="occurredOn" class="label">Date<span class="text-accent">*</span></label>
      <input id="occurredOn" name="occurredOn" type="date" required value={dateValue} class="field mt-1" />
      {#if err('occurredOn')}
        <p class="mt-1 text-xs text-danger">{err('occurredOn')}</p>
      {/if}
    </div>
  </div>

  <div>
    <label for="memo" class="label">Note</label>
    <textarea id="memo" name="memo" rows="3" maxlength="5000" class="field mt-1">{memoValue}</textarea>
  </div>

  <div class="flex items-center gap-4">
    <button type="submit" class="btn">Save changes</button>
    <a href="/owner-money/{e.id}" class="text-sm text-fg/60 hover:text-fg">Cancel</a>
  </div>
</form>

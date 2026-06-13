<script lang="ts">
  import { untrack } from 'svelte';
  import ItemPicker from '$lib/components/ItemPicker.svelte';
  import { addMoney, multiplyMoney, sumMoney } from '@thalermark/validation';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();

  type Row = {
    description: string;
    quantity: string;
    unitPrice: string;
    sourceItemId: string | null;
  };

  function blankRow(): Row {
    return { description: '', quantity: '', unitPrice: '', sourceItemId: null };
  }

  function todayIso(): string {
    return new Date().toISOString().slice(0, 10);
  }

  // Seeding mirrors /estimates/new: static inputs render value={values?.X ??
  // default}; the live-preview inputs (tax + rows) use $state with untrack()
  // initializers so a fail() re-render keeps typed values without the
  // state_referenced_locally warning.
  const values = $derived(form?.values);

  let tax = $state<string>(untrack(() => form?.values?.tax ?? ''));
  let rows = $state<Row[]>(
    untrack(() => {
      const seeded = form?.values?.lineItems;
      return seeded && seeded.length > 0
        ? seeded.map((li) => ({
            description: li.description,
            quantity: li.quantity,
            unitPrice: li.unitPrice,
            sourceItemId: li.sourceItemId ?? null,
          }))
        : [blankRow()];
    }),
  );

  const computedRows = $derived(
    rows.map((r) => ({ ...r, amount: multiplyMoney(r.quantity, r.unitPrice) })),
  );
  const subtotal = $derived(sumMoney(computedRows.map((r) => r.amount)));
  const total = $derived(addMoney(subtotal, tax));

  const fieldErrors = $derived(form?.fieldErrors ?? {});
  function err(key: string): string | undefined {
    return (fieldErrors as Record<string, string>)[key];
  }

  function addRow() {
    rows.push(blankRow());
  }

  function removeRow(index: number) {
    if (rows.length <= 1) return;
    rows.splice(index, 1);
  }
</script>

<a href="/recurring" class="eyebrow text-fg/60 hover:text-fg">← Recurring</a>
<h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-fg">
  New schedule<span class="text-accent">.</span>
</h1>

{#if form?.formError}
  <div class="mt-6 rounded-sm border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
    {form.formError}
  </div>
{/if}

{#if data.customers.length === 0}
  <p class="mt-8 text-fg/70">
    You need at least one customer before creating a recurring schedule.
    <a href="/customers/new" class="text-accent hover:underline">Add a customer →</a>
  </p>
{:else}
  <form method="post" class="mt-8 space-y-8">
    <div class="grid grid-cols-1 gap-6 sm:grid-cols-2">
      <div>
        <label for="customerId" class="label">
          Customer<span class="text-accent">*</span>
        </label>
        <select
          id="customerId"
          name="customerId"
          required
          class="field mt-1"
        >
          <option value="" disabled selected={!values?.customerId}>Select a customer…</option>
          {#each data.customers as c (c.id)}
            <option value={c.id} selected={values?.customerId === c.id}>{c.name}</option>
          {/each}
        </select>
        {#if err('customerId')}
          <p class="mt-1 text-xs text-danger">{err('customerId')}</p>
        {/if}
      </div>

      <div>
        <label for="startDate" class="label">
          First invoice on<span class="text-accent">*</span>
        </label>
        <input
          id="startDate"
          name="startDate"
          type="date"
          required
          value={values?.startDate ?? todayIso()}
          class="field mt-1"
        />
        {#if err('startDate')}
          <p class="mt-1 text-xs text-danger">{err('startDate')}</p>
        {/if}
      </div>

      <div>
        <label for="frequency" class="label">
          Frequency<span class="text-accent">*</span>
        </label>
        <select
          id="frequency"
          name="frequency"
          required
          class="field mt-1"
        >
          {#each ['weekly', 'monthly', 'yearly'] as f (f)}
            <option value={f} selected={(values?.frequency ?? 'monthly') === f}>
              {f[0].toUpperCase() + f.slice(1)}
            </option>
          {/each}
        </select>
        {#if err('frequency')}
          <p class="mt-1 text-xs text-danger">{err('frequency')}</p>
        {/if}
      </div>

      <div>
        <label for="intervalCount" class="label">
          Repeat every<span class="text-accent">*</span>
        </label>
        <input
          id="intervalCount"
          name="intervalCount"
          type="number"
          min="1"
          required
          value={values?.intervalCount ?? '1'}
          class="field mt-1"
        />
        <p class="mt-1 text-xs text-fg/50">e.g. 2 = every other period.</p>
        {#if err('intervalCount')}
          <p class="mt-1 text-xs text-danger">{err('intervalCount')}</p>
        {/if}
      </div>

      <div>
        <label for="netTermsDays" class="label">
          Payment terms (days)
        </label>
        <input
          id="netTermsDays"
          name="netTermsDays"
          type="number"
          min="0"
          value={values?.netTermsDays ?? '30'}
          class="field mt-1"
        />
        <p class="mt-1 text-xs text-fg/50">Due date = issue date + this many days.</p>
        {#if err('netTermsDays')}
          <p class="mt-1 text-xs text-danger">{err('netTermsDays')}</p>
        {/if}
      </div>

      <div>
        <label for="endDate" class="label">
          End date
        </label>
        <input
          id="endDate"
          name="endDate"
          type="date"
          value={values?.endDate ?? ''}
          class="field mt-1"
        />
        {#if err('endDate')}
          <p class="mt-1 text-xs text-danger">{err('endDate')}</p>
        {/if}
      </div>

      <div>
        <label for="maxOccurrences" class="label">
          Stop after N invoices
        </label>
        <input
          id="maxOccurrences"
          name="maxOccurrences"
          type="number"
          min="1"
          value={values?.maxOccurrences ?? ''}
          class="field mt-1"
        />
        {#if err('maxOccurrences')}
          <p class="mt-1 text-xs text-danger">{err('maxOccurrences')}</p>
        {/if}
      </div>
    </div>
    <p class="text-xs text-fg/50">
      End date and stop-after are both optional — leave blank to run until you pause or end it.
    </p>

    <fieldset class="space-y-3">
      <legend class="label">Line items</legend>
      {#if err('lineItems')}
        <p class="text-xs text-danger">{err('lineItems')}</p>
      {/if}
      <div class="overflow-hidden rounded-sm border border-fg/10 bg-surface-2">
        <table class="w-full text-left text-sm">
          <thead class="bg-surface">
            <tr class="label">
              <th class="px-3 py-2">Description</th>
              <th class="w-28 px-3 py-2 text-right">Qty</th>
              <th class="w-32 px-3 py-2 text-right">Unit price</th>
              <th class="w-32 px-3 py-2 text-right">Amount</th>
              <th class="w-10 px-3 py-2"></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-fg/10">
            {#each rows as row, i (i)}
              <tr>
                <td class="px-3 py-2">
                  <ItemPicker
                    bind:description={row.description}
                    bind:quantity={row.quantity}
                    bind:unitPrice={row.unitPrice}
                    bind:sourceItemId={row.sourceItemId}
                  />
                </td>
                <td class="px-3 py-2">
                  <input
                    type="text"
                    name="li_quantity"
                    inputmode="decimal"
                    required
                    bind:value={row.quantity}
                    class="w-full rounded-sm border border-fg/15 bg-surface px-2 py-1 text-right font-mono tabular-nums text-fg focus:border-accent focus:outline-none"
                  />
                </td>
                <td class="px-3 py-2">
                  <input
                    type="text"
                    name="li_unitPrice"
                    inputmode="decimal"
                    required
                    bind:value={row.unitPrice}
                    class="w-full rounded-sm border border-fg/15 bg-surface px-2 py-1 text-right font-mono tabular-nums text-fg focus:border-accent focus:outline-none"
                  />
                </td>
                <td class="px-3 py-2 text-right font-mono tabular-nums text-fg">
                  {computedRows[i]?.amount ?? '0.00'}
                </td>
                <td class="px-3 py-2 text-right">
                  <button
                    type="button"
                    onclick={() => removeRow(i)}
                    disabled={rows.length <= 1}
                    aria-label="Remove row"
                    class="text-fg/50 transition-colors hover:text-danger disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    ×
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <button type="button" onclick={addRow} class="text-sm font-medium text-accent hover:text-fg">
        + Add row
      </button>
    </fieldset>

    <div class="grid grid-cols-1 gap-6 sm:grid-cols-2 sm:items-end">
      <div>
        <label for="tax" class="label">Tax</label>
        <input
          id="tax"
          name="tax"
          type="text"
          inputmode="decimal"
          bind:value={tax}
          class="field mt-1 text-right font-mono tabular-nums"
        />
        {#if err('tax')}
          <p class="mt-1 text-xs text-danger">{err('tax')}</p>
        {/if}
      </div>
      <dl class="rounded-sm border border-fg/10 bg-surface-2 p-4 text-sm">
        <div class="flex justify-between">
          <dt class="label">Subtotal</dt>
          <dd class="font-mono tabular-nums text-fg">{subtotal}</dd>
        </div>
        <div class="mt-2 flex justify-between">
          <dt class="label">Tax</dt>
          <dd class="font-mono tabular-nums text-fg">{tax || '0.00'}</dd>
        </div>
        <div class="mt-3 flex justify-between border-t border-fg/10 pt-3">
          <dt class="font-mono text-xs uppercase tracking-widest text-fg/70">Total per invoice</dt>
          <dd class="font-mono tabular-nums text-lg text-fg">{total}</dd>
        </div>
      </dl>
    </div>

    <div>
      <label for="notes" class="label">Notes</label>
      <textarea
        id="notes"
        name="notes"
        rows="4"
        maxlength="5000"
        class="field mt-1"
        >{values?.notes ?? ''}</textarea
      >
    </div>

    <div class="flex items-center gap-4">
      <button
        type="submit"
        class="btn"
      >
        Create schedule
      </button>
      <a href="/recurring" class="text-sm text-fg/60 hover:text-fg">Cancel</a>
    </div>
  </form>
{/if}

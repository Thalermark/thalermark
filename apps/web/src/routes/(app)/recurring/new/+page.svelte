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

<a href="/recurring" class="eyebrow text-ink/60 hover:text-ink">← Recurring</a>
<h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-ink">
  New schedule<span class="text-gold-deep">.</span>
</h1>

{#if form?.formError}
  <div class="mt-6 rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-3 text-sm text-oxblood">
    {form.formError}
  </div>
{/if}

{#if data.customers.length === 0}
  <p class="mt-8 text-ink/70">
    You need at least one customer before creating a recurring schedule.
    <a href="/customers/new" class="text-gold-deep hover:underline">Add a customer →</a>
  </p>
{:else}
  <form method="post" class="mt-8 space-y-8">
    <div class="grid grid-cols-1 gap-6 sm:grid-cols-2">
      <div>
        <label for="customerId" class="font-mono text-xs uppercase tracking-widest text-ink/50">
          Customer<span class="text-gold-deep">*</span>
        </label>
        <select
          id="customerId"
          name="customerId"
          required
          class="mt-1 w-full rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink focus:border-gold-deep focus:outline-none"
        >
          <option value="" disabled selected={!values?.customerId}>Select a customer…</option>
          {#each data.customers as c (c.id)}
            <option value={c.id} selected={values?.customerId === c.id}>{c.name}</option>
          {/each}
        </select>
        {#if err('customerId')}
          <p class="mt-1 text-xs text-oxblood">{err('customerId')}</p>
        {/if}
      </div>

      <div>
        <label for="startDate" class="font-mono text-xs uppercase tracking-widest text-ink/50">
          First invoice on<span class="text-gold-deep">*</span>
        </label>
        <input
          id="startDate"
          name="startDate"
          type="date"
          required
          value={values?.startDate ?? todayIso()}
          class="mt-1 w-full rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink focus:border-gold-deep focus:outline-none"
        />
        {#if err('startDate')}
          <p class="mt-1 text-xs text-oxblood">{err('startDate')}</p>
        {/if}
      </div>

      <div>
        <label for="frequency" class="font-mono text-xs uppercase tracking-widest text-ink/50">
          Frequency<span class="text-gold-deep">*</span>
        </label>
        <select
          id="frequency"
          name="frequency"
          required
          class="mt-1 w-full rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink focus:border-gold-deep focus:outline-none"
        >
          {#each ['weekly', 'monthly', 'yearly'] as f (f)}
            <option value={f} selected={(values?.frequency ?? 'monthly') === f}>
              {f[0].toUpperCase() + f.slice(1)}
            </option>
          {/each}
        </select>
        {#if err('frequency')}
          <p class="mt-1 text-xs text-oxblood">{err('frequency')}</p>
        {/if}
      </div>

      <div>
        <label for="intervalCount" class="font-mono text-xs uppercase tracking-widest text-ink/50">
          Repeat every<span class="text-gold-deep">*</span>
        </label>
        <input
          id="intervalCount"
          name="intervalCount"
          type="number"
          min="1"
          required
          value={values?.intervalCount ?? '1'}
          class="mt-1 w-full rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink focus:border-gold-deep focus:outline-none"
        />
        <p class="mt-1 text-xs text-ink/50">e.g. 2 = every other period.</p>
        {#if err('intervalCount')}
          <p class="mt-1 text-xs text-oxblood">{err('intervalCount')}</p>
        {/if}
      </div>

      <div>
        <label for="netTermsDays" class="font-mono text-xs uppercase tracking-widest text-ink/50">
          Payment terms (days)
        </label>
        <input
          id="netTermsDays"
          name="netTermsDays"
          type="number"
          min="0"
          value={values?.netTermsDays ?? '30'}
          class="mt-1 w-full rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink focus:border-gold-deep focus:outline-none"
        />
        <p class="mt-1 text-xs text-ink/50">Due date = issue date + this many days.</p>
        {#if err('netTermsDays')}
          <p class="mt-1 text-xs text-oxblood">{err('netTermsDays')}</p>
        {/if}
      </div>

      <div>
        <label for="endDate" class="font-mono text-xs uppercase tracking-widest text-ink/50">
          End date
        </label>
        <input
          id="endDate"
          name="endDate"
          type="date"
          value={values?.endDate ?? ''}
          class="mt-1 w-full rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink focus:border-gold-deep focus:outline-none"
        />
        {#if err('endDate')}
          <p class="mt-1 text-xs text-oxblood">{err('endDate')}</p>
        {/if}
      </div>

      <div>
        <label for="maxOccurrences" class="font-mono text-xs uppercase tracking-widest text-ink/50">
          Stop after N invoices
        </label>
        <input
          id="maxOccurrences"
          name="maxOccurrences"
          type="number"
          min="1"
          value={values?.maxOccurrences ?? ''}
          class="mt-1 w-full rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink focus:border-gold-deep focus:outline-none"
        />
        {#if err('maxOccurrences')}
          <p class="mt-1 text-xs text-oxblood">{err('maxOccurrences')}</p>
        {/if}
      </div>
    </div>
    <p class="text-xs text-ink/50">
      End date and stop-after are both optional — leave blank to run until you pause or end it.
    </p>

    <fieldset class="space-y-3">
      <legend class="font-mono text-xs uppercase tracking-widest text-ink/50">Line items</legend>
      {#if err('lineItems')}
        <p class="text-xs text-oxblood">{err('lineItems')}</p>
      {/if}
      <div class="overflow-hidden rounded-sm border border-ink/10 bg-cream-warm">
        <table class="w-full text-left text-sm">
          <thead class="bg-cream">
            <tr class="font-mono text-xs uppercase tracking-widest text-ink/50">
              <th class="px-3 py-2">Description</th>
              <th class="w-28 px-3 py-2 text-right">Qty</th>
              <th class="w-32 px-3 py-2 text-right">Unit price</th>
              <th class="w-32 px-3 py-2 text-right">Amount</th>
              <th class="w-10 px-3 py-2"></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-ink/10">
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
                    class="w-full rounded-sm border border-ink/15 bg-cream px-2 py-1 text-right font-mono tabular-nums text-ink focus:border-gold-deep focus:outline-none"
                  />
                </td>
                <td class="px-3 py-2">
                  <input
                    type="text"
                    name="li_unitPrice"
                    inputmode="decimal"
                    required
                    bind:value={row.unitPrice}
                    class="w-full rounded-sm border border-ink/15 bg-cream px-2 py-1 text-right font-mono tabular-nums text-ink focus:border-gold-deep focus:outline-none"
                  />
                </td>
                <td class="px-3 py-2 text-right font-mono tabular-nums text-ink">
                  {computedRows[i]?.amount ?? '0.00'}
                </td>
                <td class="px-3 py-2 text-right">
                  <button
                    type="button"
                    onclick={() => removeRow(i)}
                    disabled={rows.length <= 1}
                    aria-label="Remove row"
                    class="text-ink/50 transition-colors hover:text-oxblood disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    ×
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <button type="button" onclick={addRow} class="text-sm font-medium text-gold-deep hover:text-ink">
        + Add row
      </button>
    </fieldset>

    <div class="grid grid-cols-1 gap-6 sm:grid-cols-2 sm:items-end">
      <div>
        <label for="tax" class="font-mono text-xs uppercase tracking-widest text-ink/50">Tax</label>
        <input
          id="tax"
          name="tax"
          type="text"
          inputmode="decimal"
          bind:value={tax}
          class="mt-1 w-full rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-right font-mono tabular-nums text-ink focus:border-gold-deep focus:outline-none"
        />
        {#if err('tax')}
          <p class="mt-1 text-xs text-oxblood">{err('tax')}</p>
        {/if}
      </div>
      <dl class="rounded-sm border border-ink/10 bg-cream-warm p-4 text-sm">
        <div class="flex justify-between">
          <dt class="font-mono text-xs uppercase tracking-widest text-ink/50">Subtotal</dt>
          <dd class="font-mono tabular-nums text-ink">{subtotal}</dd>
        </div>
        <div class="mt-2 flex justify-between">
          <dt class="font-mono text-xs uppercase tracking-widest text-ink/50">Tax</dt>
          <dd class="font-mono tabular-nums text-ink">{tax || '0.00'}</dd>
        </div>
        <div class="mt-3 flex justify-between border-t border-ink/10 pt-3">
          <dt class="font-mono text-xs uppercase tracking-widest text-ink/70">Total per invoice</dt>
          <dd class="font-mono tabular-nums text-lg text-ink">{total}</dd>
        </div>
      </dl>
    </div>

    <div>
      <label for="notes" class="font-mono text-xs uppercase tracking-widest text-ink/50">Notes</label>
      <textarea
        id="notes"
        name="notes"
        rows="4"
        maxlength="5000"
        class="mt-1 w-full rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink focus:border-gold-deep focus:outline-none"
        >{values?.notes ?? ''}</textarea
      >
    </div>

    <div class="flex items-center gap-4">
      <button
        type="submit"
        class="rounded-sm bg-ink px-5 py-2 text-sm font-medium text-cream transition-colors hover:bg-gold-deep"
      >
        Create schedule
      </button>
      <a href="/recurring" class="text-sm text-ink/60 hover:text-ink">Cancel</a>
    </div>
  </form>
{/if}

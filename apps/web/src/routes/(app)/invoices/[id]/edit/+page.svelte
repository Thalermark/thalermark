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

  // Seed strategy mirrors /invoices/new but the "no prior submit" source is
  // the loaded invoice instead of empty defaults / today's date. Static
  // inputs render via `value={form?.values?.X ?? data.invoice.X}`; live-
  // preview inputs (tax + line item rows) use $state with an untrack()
  // initializer so the SSR re-render after a fail() captures the right
  // initial values without firing the state_referenced_locally warning.
  const values = $derived(form?.values);

  let tax = $state<string>(
    untrack(() => form?.values?.tax ?? (data.invoice.tax === '0.00' ? '' : data.invoice.tax)),
  );

  let rows = $state<Row[]>(
    untrack(() => {
      const seeded = form?.values?.lineItems;
      if (seeded && seeded.length > 0) {
        return seeded.map((li) => ({
          description: li.description,
          quantity: li.quantity,
          unitPrice: li.unitPrice,
          sourceItemId: li.sourceItemId ?? null,
        }));
      }
      return data.invoice.lineItems.map((li) => ({
        description: li.description,
        quantity: li.quantity,
        unitPrice: li.unitPrice,
        sourceItemId: li.sourceItemId ?? null,
      }));
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

  function blankRow(): Row {
    return { description: '', quantity: '', unitPrice: '', sourceItemId: null };
  }
</script>

<a href="/invoices/{data.invoice.id}" class="eyebrow text-ink/60 hover:text-ink">← Invoice {data.invoice.number}</a>
<h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-ink">
  Edit invoice<span class="text-gold-deep">.</span>
</h1>

{#if form?.formError}
  <div class="mt-6 rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-3 text-sm text-oxblood">
    {form.formError}
  </div>
{/if}

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
        <option value="" disabled>Select a customer…</option>
        {#each data.customers as c (c.id)}
          <option
            value={c.id}
            selected={(values?.customerId ?? data.invoice.customerId) === c.id}>{c.name}</option
          >
        {/each}
      </select>
      {#if err('customerId')}
        <p class="mt-1 text-xs text-oxblood">{err('customerId')}</p>
      {/if}
    </div>

    <div>
      <label for="number" class="font-mono text-xs uppercase tracking-widest text-ink/50">
        Number<span class="text-gold-deep">*</span>
      </label>
      <input
        id="number"
        name="number"
        type="text"
        required
        maxlength="50"
        value={values?.number ?? data.invoice.number}
        class="mt-1 w-full rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink focus:border-gold-deep focus:outline-none"
      />
      {#if err('number')}
        <p class="mt-1 text-xs text-oxblood">{err('number')}</p>
      {/if}
    </div>

    <div>
      <label for="issueDate" class="font-mono text-xs uppercase tracking-widest text-ink/50">
        Issued<span class="text-gold-deep">*</span>
      </label>
      <input
        id="issueDate"
        name="issueDate"
        type="date"
        required
        value={values?.issueDate ?? data.invoice.issueDate}
        class="mt-1 w-full rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink focus:border-gold-deep focus:outline-none"
      />
      {#if err('issueDate')}
        <p class="mt-1 text-xs text-oxblood">{err('issueDate')}</p>
      {/if}
    </div>

    <div>
      <label for="dueDate" class="font-mono text-xs uppercase tracking-widest text-ink/50">
        Due<span class="text-gold-deep">*</span>
      </label>
      <input
        id="dueDate"
        name="dueDate"
        type="date"
        required
        value={values?.dueDate ?? data.invoice.dueDate}
        class="mt-1 w-full rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink focus:border-gold-deep focus:outline-none"
      />
      {#if err('dueDate')}
        <p class="mt-1 text-xs text-oxblood">{err('dueDate')}</p>
      {/if}
    </div>
  </div>

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
    <button
      type="button"
      onclick={addRow}
      class="text-sm font-medium text-gold-deep hover:text-ink"
    >
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
        <dt class="font-mono text-xs uppercase tracking-widest text-ink/70">Total</dt>
        <dd class="font-mono tabular-nums text-lg text-ink">{total}</dd>
      </div>
    </dl>
  </div>

  <div>
    <label for="notes" class="font-mono text-xs uppercase tracking-widest text-ink/50">Notes</label
    >
    <textarea
      id="notes"
      name="notes"
      rows="4"
      maxlength="5000"
      class="mt-1 w-full rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink focus:border-gold-deep focus:outline-none"
      >{values?.notes ?? data.invoice.notes ?? ''}</textarea
    >
  </div>

  <div class="flex items-center gap-4">
    <button
      type="submit"
      class="rounded-sm bg-ink px-5 py-2 text-sm font-medium text-cream transition-colors hover:bg-gold-deep"
    >
      Save changes
    </button>
    <a href="/invoices/{data.invoice.id}" class="text-sm text-ink/60 hover:text-ink">Cancel</a>
  </div>
</form>

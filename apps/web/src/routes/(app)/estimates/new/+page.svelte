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

  function plusDaysIso(days: number): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  // Seeding strategy mirrors /invoices/new (8.4c). Static inputs render via
  // value={form?.values?.X ?? default}; live-preview inputs (tax + rows)
  // use $state with untrack() initializers so SSR re-render after a fail()
  // captures the right initial values without firing the
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

<a href="/estimates" class="eyebrow text-fg/60 hover:text-fg">← Estimates</a>
<h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-fg">
  New estimate<span class="text-accent">.</span>
</h1>

{#if form?.formError}
  <div class="mt-6 rounded-sm border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
    {form.formError}
  </div>
{/if}

{#if data.customers.length === 0}
  <p class="mt-8 text-fg/70">
    You need at least one customer before creating an estimate.
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
        <label for="number" class="label">
          Number<span class="text-accent">*</span>
        </label>
        <input
          id="number"
          name="number"
          type="text"
          required
          maxlength="50"
          value={values?.number ?? data.suggestedNumber}
          class="field mt-1"
        />
        {#if err('number')}
          <p class="mt-1 text-xs text-danger">{err('number')}</p>
        {/if}
      </div>

      <div>
        <label for="issueDate" class="label">
          Issued<span class="text-accent">*</span>
        </label>
        <input
          id="issueDate"
          name="issueDate"
          type="date"
          required
          value={values?.issueDate ?? todayIso()}
          class="field mt-1"
        />
        {#if err('issueDate')}
          <p class="mt-1 text-xs text-danger">{err('issueDate')}</p>
        {/if}
      </div>

      <div>
        <label for="expiresOn" class="label">
          Expires
        </label>
        <input
          id="expiresOn"
          name="expiresOn"
          type="date"
          value={values?.expiresOn ?? plusDaysIso(30)}
          class="field mt-1"
        />
        {#if err('expiresOn')}
          <p class="mt-1 text-xs text-danger">{err('expiresOn')}</p>
        {/if}
        <p class="mt-1 text-xs text-fg/50">
          Optional. Leave blank for an open-ended quote.
        </p>
      </div>
    </div>

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
      <button
        type="button"
        onclick={addRow}
        class="text-sm font-medium text-accent hover:text-fg"
      >
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
          <dt class="font-mono text-xs uppercase tracking-widest text-fg/70">Total</dt>
          <dd class="font-mono tabular-nums text-lg text-fg">{total}</dd>
        </div>
      </dl>
    </div>

    <div>
      <label for="notes" class="label">Notes</label
      >
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
        Create estimate
      </button>
      <a href="/estimates" class="text-sm text-fg/60 hover:text-fg">Cancel</a>
    </div>
  </form>
{/if}

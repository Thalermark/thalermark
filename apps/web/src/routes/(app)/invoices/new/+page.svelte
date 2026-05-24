<script lang="ts">
  import { untrack } from 'svelte';
  import { addMoney, multiplyMoney, sumMoney } from '@thalermark/validation';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();

  type Row = { description: string; quantity: string; unitPrice: string };

  function blankRow(): Row {
    return { description: '', quantity: '', unitPrice: '' };
  }

  function todayIso(): string {
    return new Date().toISOString().slice(0, 10);
  }

  function plusDaysIso(days: number): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  // Re-seeding values into the form after a fail() re-render needs to happen
  // in SSR — without use:enhance, SK responds with a freshly server-rendered
  // page on every POST, and a client-only $effect would leave the no-JS path
  // (and the pre-hydration paint) showing empty inputs. Two-prong approach:
  //
  // 1. Static inputs (customerId, number, dates, notes) render via
  //    `value={form?.values?.X ?? default}` directly — SSR-correct, no local
  //    state needed because the user's typing is captured at POST via the
  //    name attribute.
  // 2. Inputs whose values feed the live total preview (tax, line item
  //    rows) need $state so $derived(total) can react. Their initializers
  //    read form?.values via untrack() so Svelte doesn't fire the
  //    state_referenced_locally warning — the read is intentional, and the
  //    SSR script re-runs on every plain-POST fail, so "captures initial
  //    value" is exactly the seeding behavior we want.
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
          }))
        : [blankRow()];
    }),
  );

  // Live preview mirrors the server's compute path so the user sees exactly
  // what'll be stored before submitting. Without JS, these stay at the SSR
  // values (zero, or restored from prior submit) and the server recomputes
  // on POST — the form still works, just without per-keystroke feedback.
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

  const noCustomers = $derived(data.customers.length === 0);
</script>

<a href="/invoices" class="eyebrow text-ink/60 hover:text-ink">← Invoices</a>
<h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-ink">
  New invoice<span class="text-gold-deep">.</span>
</h1>

{#if noCustomers}
  <div class="mt-8 rounded-sm border border-ink/15 bg-cream-warm p-6">
    <p class="text-ink/80">You need a customer before you can invoice.</p>
    <a
      href="/customers/new"
      class="mt-4 inline-block rounded-sm bg-ink px-4 py-2 text-sm font-medium text-cream transition-colors hover:bg-gold-deep"
    >
      Create a customer
    </a>
  </div>
{:else}
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
        <label for="number" class="font-mono text-xs uppercase tracking-widest text-ink/50">
          Number<span class="text-gold-deep">*</span>
        </label>
        <input
          id="number"
          name="number"
          type="text"
          required
          maxlength="50"
          value={values?.number ?? ''}
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
          value={values?.issueDate ?? todayIso()}
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
          value={values?.dueDate ?? plusDaysIso(30)}
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
                  <input
                    type="text"
                    name="li_description"
                    required
                    maxlength="500"
                    bind:value={row.description}
                    class="w-full rounded-sm border border-ink/15 bg-cream px-2 py-1 text-ink focus:border-gold-deep focus:outline-none"
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
        >{values?.notes ?? ''}</textarea
      >
    </div>

    <div class="flex items-center gap-4">
      <button
        type="submit"
        class="rounded-sm bg-ink px-5 py-2 text-sm font-medium text-cream transition-colors hover:bg-gold-deep"
      >
        Create invoice
      </button>
      <a href="/invoices" class="text-sm text-ink/60 hover:text-ink">Cancel</a>
    </div>
  </form>
{/if}

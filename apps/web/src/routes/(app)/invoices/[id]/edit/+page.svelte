<script lang="ts">
  import { untrack } from 'svelte';
  import ItemPicker from '$lib/components/ItemPicker.svelte';
  import { defaultPolicyId, lineTax, policyRate } from '$lib/line-tax';
  import { type LineItemType, addMoney, multiplyMoney, sumMoney } from '@thalermark/validation';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();

  type Row = {
    description: string;
    quantity: string;
    unitPrice: string;
    sourceItemId: string | null;
    type: LineItemType;
    taxable: boolean;
    taxPolicyId: string;
  };

  // Seed strategy mirrors /invoices/new but the "no prior submit" source is
  // the loaded invoice instead of empty defaults / today's date. Static
  // inputs render via `value={form?.values?.X ?? data.invoice.X}`; live-
  // preview inputs (line item rows) use $state with an untrack() initializer so
  // the SSR re-render after a fail() captures the right initial values without
  // firing the state_referenced_locally warning. Tax is derived from the lines.
  const values = $derived(form?.values);

  let rows = $state<Row[]>(
    untrack(() => {
      const seeded = form?.values?.lineItems;
      if (seeded && seeded.length > 0) {
        return seeded.map((li) => ({
          description: li.description,
          quantity: li.quantity,
          unitPrice: li.unitPrice,
          sourceItemId: li.sourceItemId ?? null,
          type: li.type === 'product' ? 'product' : 'service',
          taxable: li.taxable ?? false,
          taxPolicyId: li.taxPolicyId ?? '',
        }));
      }
      return data.invoice.lineItems.map((li) => ({
        description: li.description,
        quantity: li.quantity,
        unitPrice: li.unitPrice,
        sourceItemId: li.sourceItemId ?? null,
        type: li.type === 'product' ? 'product' : 'service',
        taxable: li.taxable ?? false,
        taxPolicyId: li.taxPolicyId ?? '',
      }));
    }),
  );

  const computedRows = $derived(
    rows.map((r) => {
      const amount = multiplyMoney(r.quantity, r.unitPrice);
      const rate = r.taxable ? policyRate(data.taxPolicies, r.taxPolicyId) : '0';
      return { ...r, amount, tax: lineTax(r.taxable, rate, amount) };
    }),
  );
  const subtotal = $derived(sumMoney(computedRows.map((r) => r.amount)));
  const taxTotal = $derived(sumMoney(computedRows.map((r) => r.tax)));
  const total = $derived(addMoney(subtotal, taxTotal));

  function resolvePolicyId(pref: string): string {
    if (pref && data.taxPolicies.some((p) => p.id === pref)) return pref;
    return defaultPolicyId(data.taxPolicies) || data.taxPolicies[0]?.id || '';
  }
  function onTaxableChange(row: Row) {
    if (row.taxable && !row.taxPolicyId) row.taxPolicyId = resolvePolicyId('');
  }
  function applyItemTax(row: Row, taxable: boolean, taxPolicyId: string | null) {
    row.taxable = taxable;
    row.taxPolicyId = taxable ? resolvePolicyId(taxPolicyId ?? '') : '';
  }

  // From-block "show on this invoice" toggles. Seed from the prior submit on a
  // fail re-render, else the invoice's stored flags. `??` respects a returned
  // `false` (only null/undefined falls through).
  const showAddress = $derived(form?.values?.showAddress ?? data.invoice.showAddress);
  const showPhone = $derived(form?.values?.showPhone ?? data.invoice.showPhone);
  const showEmail = $derived(form?.values?.showEmail ?? data.invoice.showEmail);

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
    return { description: '', quantity: '', unitPrice: '', sourceItemId: null, type: 'service', taxable: false, taxPolicyId: '' };
  }
</script>

<a href="/invoices/{data.invoice.id}" class="eyebrow text-fg/60 hover:text-fg">← Invoice {data.invoice.number}</a>
<h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-fg">
  Edit invoice<span class="text-accent">.</span>
</h1>

{#if form?.formError}
  <div class="mt-6 rounded-sm border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
    {form.formError}
  </div>
{/if}

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
        <option value="" disabled>Select a customer…</option>
        {#each data.customers as c (c.id)}
          <option
            value={c.id}
            selected={(values?.customerId ?? data.invoice.customerId) === c.id}>{c.name}</option
          >
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
        value={values?.number ?? data.invoice.number}
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
        value={values?.issueDate ?? data.invoice.issueDate}
        class="field mt-1"
      />
      {#if err('issueDate')}
        <p class="mt-1 text-xs text-danger">{err('issueDate')}</p>
      {/if}
    </div>

    <div>
      <label for="dueDate" class="label">
        Due<span class="text-accent">*</span>
      </label>
      <input
        id="dueDate"
        name="dueDate"
        type="date"
        required
        value={values?.dueDate ?? data.invoice.dueDate}
        class="field mt-1"
      />
      {#if err('dueDate')}
        <p class="mt-1 text-xs text-danger">{err('dueDate')}</p>
      {/if}
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
            <th class="w-36 px-3 py-2">Tax</th>
            <th class="w-32 px-3 py-2 text-right">Amount</th>
            <th class="w-10 px-3 py-2"></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-fg/10">
          {#each rows as row, i (i)}
            <tr>
              <td class="px-3 py-2 align-top">
                <ItemPicker
                  bind:description={row.description}
                  bind:quantity={row.quantity}
                  bind:unitPrice={row.unitPrice}
                  bind:sourceItemId={row.sourceItemId}
                  onpick={(s) => {
                    row.type = s.type;
                    applyItemTax(row, s.taxable, s.taxPolicyId);
                  }}
                />
                <select
                  bind:value={row.type}
                  name="li_type"
                  aria-label="Type"
                  class="mt-1 rounded-sm border border-fg/15 bg-surface px-1.5 py-1 text-xs text-fg/70 focus:border-accent focus:outline-none"
                >
                  <option value="service">Service</option>
                  <option value="product">Product</option>
                </select>
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
              <td class="px-3 py-2 align-top">
                <label class="flex items-center gap-1.5 text-xs text-fg/70">
                  <input
                    type="checkbox"
                    bind:checked={row.taxable}
                    onchange={() => onTaxableChange(row)}
                    class="size-4 accent-accent"
                  />
                  Taxable
                </label>
                {#if row.taxable}
                  {#if data.taxPolicies.length > 0}
                    <select
                      bind:value={row.taxPolicyId}
                      aria-label="Tax policy"
                      class="mt-1 w-full rounded-sm border border-fg/15 bg-surface px-1.5 py-1 text-xs text-fg focus:border-accent focus:outline-none"
                    >
                      {#each data.taxPolicies as p (p.id)}
                        <option value={p.id}>{p.name} ({Number(p.ratePct)}%)</option>
                      {/each}
                    </select>
                  {:else}
                    <a
                      href="/settings/tax-policies/new"
                      class="mt-1 block text-[0.65rem] text-accent hover:underline"
                    >
                      + Add a rate
                    </a>
                  {/if}
                {/if}
                <input type="hidden" name="li_taxable" value={row.taxable ? '1' : '0'} />
                <input
                  type="hidden"
                  name="li_taxPolicyId"
                  value={row.taxable ? row.taxPolicyId : ''}
                />
              </td>
              <td class="px-3 py-2 text-right align-top font-mono tabular-nums text-fg">
                {computedRows[i]?.amount ?? '0.00'}
                {#if row.taxable}
                  <span class="block text-[0.65rem] font-normal text-fg/50">
                    +{computedRows[i]?.tax ?? '0.00'} tax
                  </span>
                {/if}
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

  <div class="flex justify-end">
    <dl class="w-full max-w-xs rounded-sm border border-fg/10 bg-surface-2 p-4 text-sm">
      <div class="flex justify-between">
        <dt class="label">Subtotal</dt>
        <dd class="font-mono tabular-nums text-fg">{subtotal}</dd>
      </div>
      <div class="mt-2 flex justify-between">
        <dt class="label">Tax</dt>
        <dd class="font-mono tabular-nums text-fg">{taxTotal}</dd>
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
      >{values?.notes ?? data.invoice.notes ?? ''}</textarea
    >
  </div>

  <fieldset class="space-y-2">
    <legend class="label">Your details on this invoice</legend>
    <p class="text-xs text-fg/50">
      Choose which of your business details appear under your name. Only details you've added in
      <a href="/settings/business" class="link">Settings → Business</a> will show.
    </p>
    <label class="flex items-center gap-3 text-sm text-fg">
      <input
        type="checkbox"
        name="showAddress"
        checked={showAddress}
        class="size-4 rounded-sm border-fg/30 text-accent focus:ring-accent"
      />
      Show my address
    </label>
    <label class="flex items-center gap-3 text-sm text-fg">
      <input
        type="checkbox"
        name="showPhone"
        checked={showPhone}
        class="size-4 rounded-sm border-fg/30 text-accent focus:ring-accent"
      />
      Show my phone
    </label>
    <label class="flex items-center gap-3 text-sm text-fg">
      <input
        type="checkbox"
        name="showEmail"
        checked={showEmail}
        class="size-4 rounded-sm border-fg/30 text-accent focus:ring-accent"
      />
      Show my email
    </label>
  </fieldset>

  <div class="flex items-center gap-4">
    <button
      type="submit"
      class="btn"
    >
      Save changes
    </button>
    <a href="/invoices/{data.invoice.id}" class="text-sm text-fg/60 hover:text-fg">Cancel</a>
  </div>
</form>

<script lang="ts">
  import { untrack } from 'svelte';
  import { findEmailDupe, findNameDupes } from '$lib/customer-dupes';
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

  function blankRow(): Row {
    return { description: '', quantity: '', unitPrice: '', sourceItemId: null, type: 'service', taxable: false, taxPolicyId: '' };
  }

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

  let rows = $state<Row[]>(
    untrack(() => {
      const seeded = form?.values?.lineItems;
      return seeded && seeded.length > 0
        ? seeded.map((li) => ({
            description: li.description,
            quantity: li.quantity,
            unitPrice: li.unitPrice,
            sourceItemId: li.sourceItemId ?? null,
            type: li.type ?? 'service',
            taxable: li.taxable ?? false,
            taxPolicyId: li.taxPolicyId ?? '',
          }))
        : [blankRow()];
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

  // From-block "show on this estimate" toggles. Seed from the prior submit on a
  // fail re-render, else the company-level estimate default. `??` respects a
  // returned `false` (only null/undefined falls through).
  const showAddress = $derived(form?.values?.showAddress ?? data.showDefaults.showAddress);
  const showPhone = $derived(form?.values?.showPhone ?? data.showDefaults.showPhone);
  const showEmail = $derived(form?.values?.showEmail ?? data.showDefaults.showEmail);

  const fieldErrors = $derived(form?.fieldErrors ?? {});
  function err(key: string): string | undefined {
    return (fieldErrors as Record<string, string>)[key];
  }

  // Inline "+ Add new customer" — mirrors /invoices/new. The select can hold a
  // sentinel that opens an inline create panel; the action creates the customer
  // first, then the estimate. Dupe hints are computed client-side against the
  // loaded list (the server re-checks at submit).
  const NEW_CUSTOMER_SENTINEL = '__new__';

  // 409 recovery: a just-created customer (estimate create then failed) comes
  // back in form.extraCustomer so the re-render pre-selects them.
  const customersWithExtra = $derived(
    form?.extraCustomer
      ? [form.extraCustomer, ...data.customers.filter((c) => c.id !== form.extraCustomer!.id)]
      : data.customers,
  );

  // Bound to the select; drives the inline panel. Default: prior submit's
  // customerId, else the sentinel when there are no customers yet (zero-state
  // goes straight to inline-create), else empty so the placeholder shows.
  let customerId = $state<string>(
    untrack(() => {
      const submitted = form?.values?.customerId;
      if (submitted) return submitted;
      return data.customers.length === 0 ? NEW_CUSTOMER_SENTINEL : '';
    }),
  );
  const inlineMode = $derived(customerId === NEW_CUSTOMER_SENTINEL);

  const customerErrors = $derived(form?.customerErrors ?? {});
  function custErr(key: string): string | undefined {
    return (customerErrors as Record<string, string>)[key];
  }

  let inlineNewName = $state<string>(untrack(() => form?.values?.newCustomerName ?? ''));
  let inlineNewEmail = $state<string>(untrack(() => form?.values?.newCustomerEmail ?? ''));
  const liveEmailDupe = $derived(findEmailDupe(inlineNewEmail, data.customers));
  const liveNameDupes = $derived(findNameDupes(inlineNewName, data.customers));

  function useExisting(id: string) {
    customerId = id;
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
          bind:value={customerId}
          class="field mt-1"
        >
          <option value="" disabled>Select a customer…</option>
          <option value={NEW_CUSTOMER_SENTINEL}>+ Add new customer</option>
          {#if customersWithExtra.length > 0}
            <option value="" disabled>──────────</option>
            {#each customersWithExtra as c (c.id)}
              <option value={c.id}>{c.name}</option>
            {/each}
          {/if}
        </select>
        {#if err('customerId')}
          <p class="mt-1 text-xs text-danger">{err('customerId')}</p>
        {/if}
        {#if inlineMode}
          <div class="mt-3 space-y-3 rounded-sm border border-fg/10 bg-surface-2/60 p-4">
            <div>
              <label for="newCustomerName" class="label">
                Name<span class="text-accent">*</span>
              </label>
              <input
                id="newCustomerName"
                name="newCustomerName"
                type="text"
                maxlength="200"
                required={inlineMode}
                bind:value={inlineNewName}
                class="field mt-1"
              />
              {#if custErr('name')}
                <p class="mt-1 text-xs text-danger">{custErr('name')}</p>
              {/if}
              {#if liveNameDupes.length > 0}
                <div class="mt-2 rounded-sm border border-fg/10 bg-surface p-2 text-xs">
                  <p class="text-fg/60">
                    Looks like {liveNameDupes.length === 1 ? 'an existing customer' : 'existing customers'}:
                  </p>
                  <ul class="mt-1 space-y-1">
                    {#each liveNameDupes as dupe (dupe.id)}
                      <li class="flex items-center justify-between gap-2">
                        <span class="text-fg">{dupe.name}{#if dupe.email}<span class="text-fg/50"> · {dupe.email}</span>{/if}</span>
                        <button
                          type="button"
                          onclick={() => useExisting(dupe.id)}
                          class="rounded-sm border border-fg/15 bg-surface-2 px-2 py-1 text-xs uppercase tracking-wider text-fg/70 hover:border-accent hover:text-accent"
                        >
                          Use
                        </button>
                      </li>
                    {/each}
                  </ul>
                </div>
              {/if}
            </div>
            <div>
              <label for="newCustomerEmail" class="label">
                Email
              </label>
              <input
                id="newCustomerEmail"
                name="newCustomerEmail"
                type="email"
                maxlength="320"
                bind:value={inlineNewEmail}
                class="field mt-1"
              />
              {#if custErr('email') && custErr('email') !== 'email_dupe'}
                <p class="mt-1 text-xs text-danger">{custErr('email')}</p>
              {/if}
              <p class="mt-1 text-xs text-fg/50">
                Optional, but needed to send the estimate by email.
              </p>
            </div>
            {#if form?.dupeCustomer}
              <div class="rounded-sm border border-danger/30 bg-danger/5 p-3 text-sm">
                <p class="text-fg">
                  <span class="font-medium">{form.dupeCustomer.name}</span> already uses this email.
                </p>
                <div class="mt-2 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onclick={() => useExisting(form!.dupeCustomer!.id)}
                    class="rounded-sm bg-inverse px-3 py-1 text-xs uppercase tracking-wider text-on-inverse hover:bg-accent"
                  >
                    Use {form.dupeCustomer.name}
                  </button>
                  <span class="text-xs text-fg/50">or change the email above to create a different customer.</span>
                </div>
              </div>
            {:else if liveEmailDupe}
              <div class="rounded-sm border border-accent/30 bg-accent/5 p-3 text-sm">
                <p class="text-fg">
                  <span class="font-medium">{liveEmailDupe.name}</span> already uses this email.
                </p>
                <button
                  type="button"
                  onclick={() => useExisting(liveEmailDupe.id)}
                  class="mt-2 rounded-sm border border-fg/20 bg-surface-2 px-3 py-1 text-xs uppercase tracking-wider text-fg/70 hover:border-accent hover:text-accent"
                >
                  Use {liveEmailDupe.name}
                </button>
              </div>
            {/if}
            {#if custErr('_')}
              <p class="text-xs text-danger">{custErr('_')}</p>
            {/if}
          </div>
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
                <td class="px-3 py-2 align-top">
                  <input
                    type="text"
                    name="li_quantity"
                    inputmode="decimal"
                    required
                    bind:value={row.quantity}
                    class="w-full rounded-sm border border-fg/15 bg-surface px-2 py-1 text-right font-mono tabular-nums text-fg focus:border-accent focus:outline-none"
                  />
                </td>
                <td class="px-3 py-2 align-top">
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
                <td class="px-3 py-2 text-right align-top">
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
        >{values?.notes ?? ''}</textarea
      >
    </div>

    <fieldset class="space-y-2">
      <legend class="label">Your details on this estimate</legend>
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
        Create estimate
      </button>
      <a href="/estimates" class="text-sm text-fg/60 hover:text-fg">Cancel</a>
    </div>
  </form>

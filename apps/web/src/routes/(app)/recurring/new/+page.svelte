<script lang="ts">
  import { untrack } from 'svelte';
  import { findEmailDupe, findNameDupes } from '$lib/contact-dupes';
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

  // Seeding mirrors /estimates/new: static inputs render value={values?.X ??
  // default}; the live-preview line rows use $state with untrack() initializers.
  // Tax is derived from the lines.
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

  const fieldErrors = $derived(form?.fieldErrors ?? {});
  function err(key: string): string | undefined {
    return (fieldErrors as Record<string, string>)[key];
  }

  // Inline "+ Add new contact" — mirrors /invoices/new. The select can hold a
  // sentinel that opens an inline create panel; the action creates the contact
  // first, then the recurring schedule. Dupe hints are computed client-side
  // against the loaded list (the server re-checks at submit).
  const NEW_CONTACT_SENTINEL = '__new__';

  // 409 recovery: a just-created contact (schedule create then failed) comes
  // back in form.extraContact so the re-render pre-selects them.
  const contactsWithExtra = $derived(
    form?.extraContact
      ? [form.extraContact, ...data.contacts.filter((c) => c.id !== form.extraContact!.id)]
      : data.contacts,
  );

  // Bound to the select; drives the inline panel. Default: prior submit's
  // contactId, else the sentinel when there are no contacts yet (zero-state
  // goes straight to inline-create), else empty so the placeholder shows.
  let contactId = $state<string>(
    untrack(() => {
      const submitted = form?.values?.contactId;
      if (submitted) return submitted;
      return data.contacts.length === 0 ? NEW_CONTACT_SENTINEL : '';
    }),
  );
  const inlineMode = $derived(contactId === NEW_CONTACT_SENTINEL);

  const contactErrors = $derived(form?.contactErrors ?? {});
  function custErr(key: string): string | undefined {
    return (contactErrors as Record<string, string>)[key];
  }

  let inlineNewName = $state<string>(untrack(() => form?.values?.newContactName ?? ''));
  let inlineNewEmail = $state<string>(untrack(() => form?.values?.newContactEmail ?? ''));
  const liveEmailDupe = $derived(findEmailDupe(inlineNewEmail, data.contacts));
  const liveNameDupes = $derived(findNameDupes(inlineNewName, data.contacts));

  function useExisting(id: string) {
    contactId = id;
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

  <form method="post" class="mt-8 space-y-8">
    <div class="grid grid-cols-1 gap-6 sm:grid-cols-2">
      <div>
        <label for="contactId" class="label">
          Contact<span class="text-accent">*</span>
        </label>
        <select
          id="contactId"
          name="contactId"
          required
          bind:value={contactId}
          class="field mt-1"
        >
          <option value="" disabled>Select a contact…</option>
          <option value={NEW_CONTACT_SENTINEL}>+ Add new contact</option>
          {#if contactsWithExtra.length > 0}
            <option value="" disabled>──────────</option>
            {#each contactsWithExtra as c (c.id)}
              <option value={c.id}>{c.name}</option>
            {/each}
          {/if}
        </select>
        {#if err('contactId')}
          <p class="mt-1 text-xs text-danger">{err('contactId')}</p>
        {/if}
        {#if inlineMode}
          <div class="mt-3 space-y-3 rounded-sm border border-fg/10 bg-surface-2/60 p-4">
            <div>
              <label for="newContactName" class="label">
                Name<span class="text-accent">*</span>
              </label>
              <input
                id="newContactName"
                name="newContactName"
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
                    Looks like {liveNameDupes.length === 1 ? 'an existing contact' : 'existing contacts'}:
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
              <label for="newContactEmail" class="label">
                Email
              </label>
              <input
                id="newContactEmail"
                name="newContactEmail"
                type="email"
                maxlength="320"
                bind:value={inlineNewEmail}
                class="field mt-1"
              />
              {#if custErr('email') && custErr('email') !== 'email_dupe'}
                <p class="mt-1 text-xs text-danger">{custErr('email')}</p>
              {/if}
              <p class="mt-1 text-xs text-fg/50">
                Optional, but needed to email the generated invoices.
              </p>
            </div>
            {#if form?.dupeContact}
              <div class="rounded-sm border border-danger/30 bg-danger/5 p-3 text-sm">
                <p class="text-fg">
                  <span class="font-medium">{form.dupeContact.name}</span> already uses this email.
                </p>
                <div class="mt-2 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onclick={() => useExisting(form!.dupeContact!.id)}
                    class="rounded-sm bg-inverse px-3 py-1 text-xs uppercase tracking-wider text-on-inverse hover:bg-accent"
                  >
                    Use {form.dupeContact.name}
                  </button>
                  <span class="text-xs text-fg/50">or change the email above to create a different contact.</span>
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
      <button type="button" onclick={addRow} class="text-sm font-medium text-accent hover:text-fg">
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

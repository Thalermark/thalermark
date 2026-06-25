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

  // Resolve a preferred policy id to a concrete, currently-active one — falls
  // back to the company default (or the first policy) when the preference is
  // empty or points at an archived/removed policy.
  function resolvePolicyId(pref: string): string {
    if (pref && data.taxPolicies.some((p) => p.id === pref)) return pref;
    return defaultPolicyId(data.taxPolicies) || data.taxPolicies[0]?.id || '';
  }

  // Toggling a row taxable seeds it with a concrete policy so the rate isn't 0.
  function onTaxableChange(row: Row) {
    if (row.taxable && !row.taxPolicyId) row.taxPolicyId = resolvePolicyId('');
  }

  // Prefill a row's tax from the picked catalog item.
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

  // Re-seeding values into the form after a fail() re-render needs to happen
  // in SSR — without use:enhance, SK responds with a freshly server-rendered
  // page on every POST, and a client-only $effect would leave the no-JS path
  // (and the pre-hydration paint) showing empty inputs. Two-prong approach:
  //
  // 1. Static inputs (contactId, number, dates, notes) render via
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

  // Live preview mirrors the server's compute path so the user sees exactly
  // what'll be stored before submitting. Tax is the derived sum of per-line
  // tax — never typed by hand. Without JS, these stay at the SSR values and the
  // server recomputes on POST — the form still works, just without per-keystroke
  // feedback.
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

  // From-block "show on this invoice" toggles. Seed from the prior submit on a
  // fail re-render, else the company-level default. `??` respects a returned
  // `false` (only null/undefined falls through).
  const showAddress = $derived(form?.values?.showAddress ?? data.showDefaults.showAddress);
  const showPhone = $derived(form?.values?.showPhone ?? data.showDefaults.showPhone);
  const showEmail = $derived(form?.values?.showEmail ?? data.showDefaults.showEmail);

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

  // Sentinel for the "+ Add new contact" option. Server reads `contactId`
  // and branches on this exact string (matches the literal in +page.server.ts).
  // Inline mode opens whenever the contact select holds this value.
  const NEW_CONTACT_SENTINEL = '__new__';

  // 409 recovery: when the new-contact create succeeded but the invoice
  // create failed (e.g. number taken), the server returns the just-created
  // contact in form.extraContact + values.contactId = its id. Merge it
  // into the dropdown so the re-render can pre-select them instead of
  // dropping the user back into the sentinel.
  const contactsWithExtra = $derived(
    form?.extraContact
      ? [form.extraContact, ...data.contacts.filter((c) => c.id !== form.extraContact!.id)]
      : data.contacts,
  );

  // Bound to the select; drives the inline-fields toggle. Default: prior
  // submit's contactId, else the sentinel when no existing contacts
  // (zero-state goes straight into inline-create instead of bouncing out),
  // else empty so the placeholder shows.
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

  // Live dupe-hints in inline mode. As the user types name/email, find
  // matches against the already-loaded contact list. Email match is the
  // strong signal (also enforced server-side as a hard block); name match
  // is advisory. Bound to inputs via $state so the suggestions reactively
  // narrow. Initial values seed from form?.values to survive a fail()
  // re-render — server may have just rejected the submit, and re-showing
  // the warning helps the user understand why.
  let inlineNewName = $state<string>(untrack(() => form?.values?.newContactName ?? ''));
  let inlineNewEmail = $state<string>(untrack(() => form?.values?.newContactEmail ?? ''));
  const liveEmailDupe = $derived(findEmailDupe(inlineNewEmail, data.contacts));
  const liveNameDupes = $derived(findNameDupes(inlineNewName, data.contacts));

  function useExisting(id: string) {
    contactId = id;
  }
</script>

<a href="/invoices" class="eyebrow text-fg/60 hover:text-fg">← Invoices</a>
<h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-fg">
  New invoice<span class="text-accent">.</span>
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
              Optional, but needed to send the invoice by email.
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
      <label for="dueDate" class="label">
        Due<span class="text-accent">*</span>
      </label>
      <input
        id="dueDate"
        name="dueDate"
        type="date"
        required
        value={values?.dueDate ?? plusDaysIso(30)}
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
                <!-- Always-present hidden inputs keep the server's index-zip aligned. -->
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
      Create invoice
    </button>
    <a href="/invoices" class="text-sm text-fg/60 hover:text-fg">Cancel</a>
  </div>
</form>

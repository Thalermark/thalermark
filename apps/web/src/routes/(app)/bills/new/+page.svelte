<script lang="ts">
  import ContactPicker from '$lib/components/ContactPicker.svelte';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();

  // Re-seed from a failed submit so the user keeps what they typed.
  const v = $derived(form?.values);
  const fieldErrors = $derived(form?.fieldErrors ?? {});
  function fe(key: string): string | undefined {
    return fieldErrors[key];
  }
</script>

<a href="/bills" class="eyebrow text-fg/60 hover:text-fg">← Bills</a>
<h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-fg">
  New bill<span class="text-accent">.</span>
</h1>
<p class="mt-3 max-w-prose text-sm text-fg/60">
  A bill is something you owe a vendor and will pay later. Record it now; mark it paid when you
  settle it.
</p>

{#if form?.formError}
  <p class="callout mt-6 border-danger/30 bg-danger/5 text-danger">{form.formError}</p>
{/if}

<form method="POST" class="mt-8 max-w-2xl space-y-6">
  <div>
    <span class="label">Vendor<span class="text-accent">*</span></span>
    <ContactPicker
      initialContactId={v?.contactId ?? ''}
      initialContactName={v?.contactName ?? ''}
      initialNewName={v?.newContactName ?? ''}
      initialNewEmail={v?.newContactEmail ?? ''}
      fieldError={fe('contactId')}
      contactErrors={form?.contactErrors}
      dupeContact={form?.dupeContact}
    />
  </div>

  <div class="grid gap-6 sm:grid-cols-2">
    <label class="block">
      <span class="label">Category<span class="text-accent">*</span></span>
      <select name="categoryAccountId" class="field mt-1" required>
        <option value="" disabled selected={!v?.categoryAccountId}>Choose a category…</option>
        {#each data.categories as cat (cat.id)}
          <option value={cat.id} selected={v?.categoryAccountId === cat.id}>{cat.label}</option>
        {/each}
      </select>
      {#if fe('categoryAccountId')}
        <p class="mt-1 text-xs text-danger">{fe('categoryAccountId')}</p>
      {/if}
    </label>

    <label class="block">
      <span class="label">Amount<span class="text-accent">*</span></span>
      <input
        name="amount"
        inputmode="decimal"
        placeholder="0.00"
        value={v?.amount ?? ''}
        class="field mt-1"
        required
      />
      {#if fe('amount')}
        <p class="mt-1 text-xs text-danger">{fe('amount')}</p>
      {/if}
    </label>

    <label class="block">
      <span class="label">Bill date<span class="text-accent">*</span></span>
      <input
        type="date"
        name="billDate"
        value={v?.billDate ?? data.today}
        class="field mt-1"
        required
      />
      {#if fe('billDate')}
        <p class="mt-1 text-xs text-danger">{fe('billDate')}</p>
      {/if}
    </label>

    <label class="block">
      <span class="label">Due date<span class="text-accent">*</span></span>
      <input type="date" name="dueDate" value={v?.dueDate ?? data.today} class="field mt-1" required />
      {#if fe('dueDate')}
        <p class="mt-1 text-xs text-danger">{fe('dueDate')}</p>
      {/if}
    </label>
  </div>

  <label class="block">
    <span class="label">Reference</span>
    <input
      name="reference"
      maxlength="100"
      placeholder="The vendor's bill / invoice number"
      value={v?.reference ?? ''}
      class="field mt-1"
    />
  </label>

  <label class="block">
    <span class="label">Memo</span>
    <textarea name="memo" rows="3" class="field mt-1" placeholder="Optional note">{v?.memo ?? ''}</textarea>
  </label>

  <div class="flex items-center gap-4">
    <button type="submit" class="btn">Save bill</button>
    <a href="/bills" class="text-sm text-fg/60 hover:text-fg">Cancel</a>
  </div>
</form>

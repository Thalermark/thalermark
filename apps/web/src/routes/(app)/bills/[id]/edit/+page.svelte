<script lang="ts">
  import ContactPicker from '$lib/components/ContactPicker.svelte';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const bill = $derived(data.bill);
  // Re-seed from a failed submit; otherwise from the loaded bill.
  const v = $derived(form?.values);
  const fieldErrors = $derived(form?.fieldErrors ?? {});
  function fe(key: string): string | undefined {
    return fieldErrors[key];
  }
</script>

<a href="/bills/{bill.id}" class="eyebrow text-fg/60 hover:text-fg">← {bill.vendorName}</a>
<h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-fg">
  Edit bill<span class="text-accent">.</span>
</h1>

{#if form?.formError}
  <p class="callout mt-6 border-danger/30 bg-danger/5 text-danger">{form.formError}</p>
{/if}

<form method="POST" class="mt-8 max-w-2xl space-y-6">
  <div>
    <span class="label">Vendor<span class="text-accent">*</span></span>
    <ContactPicker
      initialContactId={v?.contactId ?? bill.contactId}
      initialContactName={v?.contactName ?? bill.vendorName}
      allowCreate={false}
      fieldError={fe('contactId')}
    />
  </div>

  <div class="grid gap-6 sm:grid-cols-2">
    <label class="block">
      <span class="label">Category<span class="text-accent">*</span></span>
      <select name="categoryAccountId" class="field mt-1" required>
        {#each data.categories as cat (cat.id)}
          <option
            value={cat.id}
            selected={(v?.categoryAccountId ?? bill.categoryAccountId) === cat.id}
          >
            {cat.label}
          </option>
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
        value={v?.amount ?? bill.amount}
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
        value={v?.billDate ?? bill.billDate}
        class="field mt-1"
        required
      />
      {#if fe('billDate')}
        <p class="mt-1 text-xs text-danger">{fe('billDate')}</p>
      {/if}
    </label>

    <label class="block">
      <span class="label">Due date<span class="text-accent">*</span></span>
      <input
        type="date"
        name="dueDate"
        value={v?.dueDate ?? bill.dueDate}
        class="field mt-1"
        required
      />
      {#if fe('dueDate')}
        <p class="mt-1 text-xs text-danger">{fe('dueDate')}</p>
      {/if}
    </label>
  </div>

  <label class="block">
    <span class="label">Reference</span>
    <input name="reference" maxlength="100" value={v?.reference ?? bill.reference ?? ''} class="field mt-1" />
  </label>

  <label class="block">
    <span class="label">Memo</span>
    <textarea name="memo" rows="3" class="field mt-1">{v?.memo ?? bill.memo ?? ''}</textarea>
  </label>

  <div class="flex items-center gap-4">
    <button type="submit" class="btn">Save changes</button>
    <a href="/bills/{bill.id}" class="text-sm text-fg/60 hover:text-fg">Cancel</a>
  </div>
</form>

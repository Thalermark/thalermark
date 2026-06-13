<script lang="ts">
  import type { PageProps } from './$types';

  let { form }: PageProps = $props();
  const values = $derived(form?.values ?? {});
  const fieldErrors = $derived(form?.fieldErrors ?? {});

  type FieldKey = 'name' | 'description' | 'unitPrice' | 'unitLabel' | 'defaultQuantity';
  function v(key: FieldKey): string {
    const raw = (values as Record<string, unknown>)[key];
    return typeof raw === 'string' ? raw : '';
  }
  function err(key: FieldKey): string | undefined {
    return (fieldErrors as Record<string, string>)[key];
  }
</script>

<a href="/settings/items" class="eyebrow text-fg/60 hover:text-fg">← Items</a>
<h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-fg">
  New item<span class="text-accent">.</span>
</h1>

{#if form?.formError}
  <div class="mt-6 rounded-sm border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
    {form.formError}
  </div>
{/if}

<form method="post" class="mt-8 space-y-6">
  <div>
    <label for="name" class="label">
      Name<span class="text-accent">*</span>
    </label>
    <input
      id="name"
      name="name"
      type="text"
      required
      maxlength="200"
      value={v('name')}
      class="field mt-1"
    />
    {#if err('name')}
      <p class="mt-1 text-xs text-danger">{err('name')}</p>
    {/if}
  </div>

  <div>
    <label for="description" class="label">
      Description
    </label>
    <textarea
      id="description"
      name="description"
      rows="3"
      maxlength="5000"
      class="field mt-1"
      >{v('description')}</textarea
    >
    <p class="mt-1 text-xs text-fg/50">Flows into the line item when this is picked.</p>
  </div>

  <div class="grid grid-cols-1 gap-6 sm:grid-cols-3">
    <div>
      <label for="unitPrice" class="label">
        Unit price
      </label>
      <input
        id="unitPrice"
        name="unitPrice"
        type="text"
        inputmode="decimal"
        placeholder="0.00"
        value={v('unitPrice')}
        class="field mt-1"
      />
      {#if err('unitPrice')}
        <p class="mt-1 text-xs text-danger">{err('unitPrice')}</p>
      {/if}
    </div>
    <div>
      <label for="unitLabel" class="label">
        Unit
      </label>
      <input
        id="unitLabel"
        name="unitLabel"
        type="text"
        maxlength="50"
        placeholder="hour, sq ft, …"
        value={v('unitLabel')}
        class="field mt-1"
      />
      {#if err('unitLabel')}
        <p class="mt-1 text-xs text-danger">{err('unitLabel')}</p>
      {/if}
    </div>
    <div>
      <label for="defaultQuantity" class="label">
        Default qty
      </label>
      <input
        id="defaultQuantity"
        name="defaultQuantity"
        type="text"
        inputmode="decimal"
        placeholder="1"
        value={v('defaultQuantity')}
        class="field mt-1"
      />
      {#if err('defaultQuantity')}
        <p class="mt-1 text-xs text-danger">{err('defaultQuantity')}</p>
      {/if}
    </div>
  </div>

  <div class="flex items-center gap-4">
    <button
      type="submit"
      class="btn"
    >
      Create item
    </button>
    <a href="/settings/items" class="text-sm text-fg/60 hover:text-fg">Cancel</a>
  </div>
</form>

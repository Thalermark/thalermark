<script lang="ts">
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();

  // First render seeds from the loaded item; on a fail() re-render the
  // just-submitted values win so typing isn't lost (same shape as the create
  // form, different initial source).
  const seed = $derived(form?.values ?? data.item);
  const fieldErrors = $derived(form?.fieldErrors ?? {});

  type FieldKey = 'name' | 'description' | 'unitPrice' | 'unitLabel' | 'defaultQuantity';
  function v(key: FieldKey): string {
    const raw = (seed as Record<string, unknown>)[key];
    return typeof raw === 'string' ? raw : '';
  }
  function err(key: FieldKey): string | undefined {
    return (fieldErrors as Record<string, string>)[key];
  }
</script>

<a href="/settings/items/{data.item.id}" class="eyebrow text-ink/60 hover:text-ink">← {data.item.name}</a>
<h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-ink">
  Edit item<span class="text-gold-deep">.</span>
</h1>

{#if form?.formError}
  <div class="mt-6 rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-3 text-sm text-oxblood">
    {form.formError}
  </div>
{/if}

<form method="post" class="mt-8 space-y-6">
  <div>
    <label for="name" class="font-mono text-xs uppercase tracking-widest text-ink/50">
      Name<span class="text-gold-deep">*</span>
    </label>
    <input
      id="name"
      name="name"
      type="text"
      required
      maxlength="200"
      value={v('name')}
      class="mt-1 w-full rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink focus:border-gold-deep focus:outline-none"
    />
    {#if err('name')}
      <p class="mt-1 text-xs text-oxblood">{err('name')}</p>
    {/if}
  </div>

  <div>
    <label for="description" class="font-mono text-xs uppercase tracking-widest text-ink/50">
      Description
    </label>
    <textarea
      id="description"
      name="description"
      rows="3"
      maxlength="5000"
      class="mt-1 w-full rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink focus:border-gold-deep focus:outline-none"
      >{v('description')}</textarea
    >
    <p class="mt-1 text-xs text-ink/50">Flows into the line item when this is picked.</p>
  </div>

  <div class="grid grid-cols-1 gap-6 sm:grid-cols-3">
    <div>
      <label for="unitPrice" class="font-mono text-xs uppercase tracking-widest text-ink/50">
        Unit price
      </label>
      <input
        id="unitPrice"
        name="unitPrice"
        type="text"
        inputmode="decimal"
        placeholder="0.00"
        value={v('unitPrice')}
        class="mt-1 w-full rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink focus:border-gold-deep focus:outline-none"
      />
      {#if err('unitPrice')}
        <p class="mt-1 text-xs text-oxblood">{err('unitPrice')}</p>
      {/if}
    </div>
    <div>
      <label for="unitLabel" class="font-mono text-xs uppercase tracking-widest text-ink/50">
        Unit
      </label>
      <input
        id="unitLabel"
        name="unitLabel"
        type="text"
        maxlength="50"
        placeholder="hour, sq ft, …"
        value={v('unitLabel')}
        class="mt-1 w-full rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink focus:border-gold-deep focus:outline-none"
      />
      {#if err('unitLabel')}
        <p class="mt-1 text-xs text-oxblood">{err('unitLabel')}</p>
      {/if}
    </div>
    <div>
      <label for="defaultQuantity" class="font-mono text-xs uppercase tracking-widest text-ink/50">
        Default qty
      </label>
      <input
        id="defaultQuantity"
        name="defaultQuantity"
        type="text"
        inputmode="decimal"
        placeholder="1"
        value={v('defaultQuantity')}
        class="mt-1 w-full rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink focus:border-gold-deep focus:outline-none"
      />
      {#if err('defaultQuantity')}
        <p class="mt-1 text-xs text-oxblood">{err('defaultQuantity')}</p>
      {/if}
    </div>
  </div>

  <div class="flex items-center gap-4">
    <button
      type="submit"
      class="rounded-sm bg-ink px-5 py-2 text-sm font-medium text-cream transition-colors hover:bg-gold-deep"
    >
      Save changes
    </button>
    <a href="/settings/items/{data.item.id}" class="text-sm text-ink/60 hover:text-ink">Cancel</a>
  </div>
</form>

<script lang="ts">
  import type { PageProps } from './$types';

  let { form }: PageProps = $props();
  const values = $derived(form?.values ?? {});
  const fieldErrors = $derived(form?.fieldErrors ?? {});

  type FieldKey = 'name' | 'ratePct';
  function v(key: FieldKey): string {
    const raw = (values as Record<string, unknown>)[key];
    return typeof raw === 'string' ? raw : '';
  }
  function err(key: 'name' | 'ratePct'): string | undefined {
    return (fieldErrors as Record<string, string>)[key];
  }
  const isDefault = $derived((values as Record<string, unknown>).isDefault === true);
</script>

<a href="/settings/tax-policies" class="eyebrow text-fg/60 hover:text-fg">← Tax policies</a>
<h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-fg">
  New tax policy<span class="text-accent">.</span>
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
      placeholder="General, Reduced, Exempt…"
      value={v('name')}
      class="field mt-1"
    />
    {#if err('name')}
      <p class="mt-1 text-xs text-danger">{err('name')}</p>
    {/if}
  </div>

  <div class="max-w-[12rem]">
    <label for="ratePct" class="label">
      Rate (%)
    </label>
    <input
      id="ratePct"
      name="ratePct"
      type="text"
      inputmode="decimal"
      placeholder="8.25"
      value={v('ratePct')}
      class="field mt-1"
    />
    {#if err('ratePct')}
      <p class="mt-1 text-xs text-danger">{err('ratePct')}</p>
    {/if}
    <p class="mt-1 text-xs text-fg/50">A percentage, e.g. 8.25 for 8.25%.</p>
  </div>

  <label class="flex items-center gap-3 text-sm text-fg/80">
    <input type="checkbox" name="isDefault" checked={isDefault} class="size-4 accent-accent" />
    Make this the default for new taxable lines
  </label>

  <div class="flex items-center gap-4">
    <button type="submit" class="btn"> Create policy </button>
    <a href="/settings/tax-policies" class="text-sm text-fg/60 hover:text-fg">Cancel</a>
  </div>
</form>

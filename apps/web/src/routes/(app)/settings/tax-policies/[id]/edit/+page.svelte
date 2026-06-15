<script lang="ts">
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();

  // First render seeds from the loaded policy (rate normalised "8.2500" →
  // "8.25"); on a fail() re-render the just-submitted values win.
  const seed = $derived(
    form?.values ?? {
      name: data.policy.name,
      ratePct: String(Number(data.policy.ratePct)),
      isDefault: data.policy.isDefault,
    },
  );
  const fieldErrors = $derived(form?.fieldErrors ?? {});

  function v(key: 'name' | 'ratePct'): string {
    const raw = (seed as Record<string, unknown>)[key];
    return typeof raw === 'string' ? raw : '';
  }
  function err(key: 'name' | 'ratePct'): string | undefined {
    return (fieldErrors as Record<string, string>)[key];
  }
  const isDefault = $derived((seed as Record<string, unknown>).isDefault === true);
</script>

<a href="/settings/tax-policies/{data.policy.id}" class="eyebrow text-fg/60 hover:text-fg"
  >← {data.policy.name}</a
>
<h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-fg">
  Edit tax policy<span class="text-accent">.</span>
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
  </div>

  <label class="flex items-center gap-3 text-sm text-fg/80">
    <input type="checkbox" name="isDefault" checked={isDefault} class="size-4 accent-accent" />
    Make this the default for new taxable lines
  </label>

  <div class="flex items-center gap-4">
    <button type="submit" class="btn"> Save changes </button>
    <a href="/settings/tax-policies/{data.policy.id}" class="text-sm text-fg/60 hover:text-fg"
      >Cancel</a
    >
  </div>
</form>

<script lang="ts">
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
</script>

<span class="eyebrow">Almost there</span>
<h1 class="mt-3 font-serif text-3xl font-light leading-tight tracking-tight text-ink">
  Make it yours<span class="text-gold-deep">.</span>
</h1>
<p class="mt-4 text-ink/70">
  Add a logo and it'll appear on every invoice and estimate your customers see. Optional — you can
  always add one later from Settings.
</p>

<div class="mt-8 rounded-sm border border-ink/15 bg-cream-warm px-6 py-6">
  {#if data.logo}
    <img
      src={data.logo.url}
      alt="Your logo"
      class="max-h-24 max-w-[16rem] rounded-sm border border-ink/10 bg-cream object-contain p-2"
    />
    <p class="mt-3 font-mono text-xs uppercase tracking-widest text-sage">Looking sharp.</p>
  {:else}
    <p class="text-sm text-ink/50">No logo yet.</p>
  {/if}

  <form
    method="POST"
    action="?/uploadLogo"
    enctype="multipart/form-data"
    class="mt-5 flex flex-wrap items-center gap-3"
  >
    <input type="hidden" name="companyId" value={data.company.id} />
    <input
      type="file"
      name="logo"
      accept="image/png,image/jpeg,image/webp"
      class="text-sm text-ink/70 file:mr-3 file:rounded-sm file:border-0 file:bg-ink file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-cream hover:file:bg-gold-deep"
    />
    <button
      type="submit"
      class="rounded-sm border border-ink/25 px-4 py-2 text-sm font-medium text-ink transition-colors hover:border-ink"
    >
      {data.logo ? 'Replace' : 'Upload'}
    </button>
  </form>
  {#if form?.logoError}
    <p class="mt-3 text-sm text-oxblood">{form.logoError}</p>
  {/if}
</div>

<div class="mt-10 flex items-center justify-between gap-4">
  <a
    href="/"
    class="font-mono text-xs uppercase tracking-widest text-ink/50 hover:text-ink"
  >
    Go to dashboard
  </a>
  <a
    href="/invoices/new"
    class="rounded-sm bg-ink px-6 py-3 text-sm font-medium text-cream transition-colors hover:bg-gold-deep"
  >
    Send your first invoice →
  </a>
</div>

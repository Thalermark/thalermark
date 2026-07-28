<script lang="ts">
  import StartingBalances from '$lib/components/StartingBalances.svelte';
  import type { PageProps } from './$types';

  // Last wizard step. Asked here because this is the one moment someone knows
  // the answer and is in a setting-up frame of mind — and because a business
  // that has been trading since January still files ONE return for the whole
  // year. Miss this and their tax worksheet is short by however many months
  // they spent somewhere else, with nothing on the page to say so.
  //
  // Deliberately last: it's the biggest ask of the four and shouldn't stand
  // between anyone and a working account. Skipping costs nothing — Settings →
  // Import & export is the same component.
  let { data, form }: PageProps = $props();
</script>

<span class="eyebrow">Last one</span>
<h1 class="mt-3 font-serif text-3xl font-light leading-tight tracking-tight text-fg">
  What you're bringing with you<span class="text-accent">.</span>
</h1>
<p class="mt-4 text-fg/70">
  If your business existed before today, tell us where it stood — what's in the bank, what you're
  owed, what you owe. Coming from other accounting software? There's a fuller option below that
  takes your closing figures straight from a file.
</p>
<p class="mt-3 text-sm text-fg/50">
  Optional, and you can do it later from Settings → Import &amp; export. Worth doing before your
  first tax year ends, though — the worksheet only covers what it knows about.
</p>

<StartingBalances {data} {form} cancelHref="/" cancelLabel="Skip for now" showClear={false} />

<div class="mt-10 flex items-center justify-end gap-4 border-t border-fg/10 pt-6">
  <a href="/invoices/new" class="btn px-6 py-3"> Send your first invoice → </a>
</div>

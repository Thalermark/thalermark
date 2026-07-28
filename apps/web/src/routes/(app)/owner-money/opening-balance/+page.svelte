<script lang="ts">
  import StartingBalances from '$lib/components/StartingBalances.svelte';
  import type { PageProps } from './$types';

  // Heading only — the forms live in <StartingBalances>, shared with Settings →
  // Import & export and the welcome wizard. See $lib/opening-balance.server.ts
  // for why sharing matters (one record per company, last save wins).
  let { data, form }: PageProps = $props();
</script>

<a href="/owner-money" class="eyebrow text-fg/60 hover:text-fg">← Investments</a>
<h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-fg">
  Starting balances<span class="text-accent">.</span>
</h1>
<p class="mt-4 max-w-2xl text-sm text-fg/60">
  What your business already had when you started using Thalermark — so your numbers are right from
  day one. Fill in what applies; leave the rest blank.
</p>

<StartingBalances {data} {form} cancelHref="/owner-money" />

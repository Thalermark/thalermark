<script lang="ts">
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const d = $derived(data.dashboard);

  // Display formatting only — the authoritative value is the decimal string
  // from the API. Realistic position figures sit well within Number's safe
  // range, so toLocaleString is fine for the headline.
  const fmt = (s: string) =>
    Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  const periods = [
    { key: 'month', label: 'This month' },
    { key: '30d', label: 'Last 30 days' },
    { key: 'ytd', label: 'Year to date' },
  ];
  const flowLabel = $derived(
    data.period === 'ytd' ? 'this year' : data.period === '30d' ? 'last 30 days' : 'this month',
  );
</script>

<span class="eyebrow text-ink/60">{data.companyName}</span>
<h1 class="mt-2 font-serif text-4xl font-light leading-none tracking-tight text-ink">
  Where you stand<span class="text-gold-deep">.</span>
</h1>

<div class="mt-6 flex flex-wrap gap-2">
  {#each periods as p (p.key)}
    <a
      href="/?period={p.key}"
      class="rounded-sm border px-3 py-1 font-mono text-xs uppercase tracking-widest transition-colors {data.period ===
      p.key
        ? 'border-gold-deep text-gold-deep'
        : 'border-ink/15 text-ink/60 hover:border-ink/40 hover:text-ink'}"
    >
      {p.label}
    </a>
  {/each}
</div>

<dl class="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-3">
  <div class="rounded-sm border border-ink/10 bg-cream-warm p-6">
    <dt class="font-mono text-xs uppercase tracking-widest text-ink/50">Money in</dt>
    <dd class="mt-2 font-serif text-3xl font-light tabular-nums text-ink">{fmt(d.moneyIn)}</dd>
    <p class="mt-1 text-xs text-ink/40">{flowLabel}</p>
  </div>
  <div class="rounded-sm border border-ink/10 bg-cream-warm p-6">
    <dt class="font-mono text-xs uppercase tracking-widest text-ink/50">Money out</dt>
    <dd class="mt-2 font-serif text-3xl font-light tabular-nums text-ink">{fmt(d.moneyOut)}</dd>
    <p class="mt-1 text-xs text-ink/40">{flowLabel}</p>
  </div>
  <div class="rounded-sm border border-ink/10 bg-cream-warm p-6">
    <dt class="font-mono text-xs uppercase tracking-widest text-ink/50">Owed to you</dt>
    <dd class="mt-2 font-serif text-3xl font-light tabular-nums text-ink">{fmt(d.owed)}</dd>
    <p class="mt-1 text-xs text-ink/40">outstanding now</p>
  </div>
</dl>

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

  // Border accent per nudge tone (gold = good, oxblood = warning, ink = info).
  const toneClass = (tone: string) =>
    tone === 'warning'
      ? 'border-oxblood/30 bg-oxblood/5'
      : tone === 'good'
        ? 'border-gold-deep/30 bg-gold-deep/5'
        : 'border-ink/15 bg-cream-warm';

  // Anomaly flagging (deterministic): unusual spending vs the company's own
  // history. Shown only when something actually flags.
  const a = $derived(data.anomalies);
  const showAnomalies = $derived(a.overall !== null || a.categories.length > 0);
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

{#if showAnomalies}
  <section class="mt-8">
    <h2 class="font-mono text-xs uppercase tracking-widest text-ink/50">Unusual spending</h2>
    <ul class="mt-3 space-y-3">
      {#if a.overall}
        <li class="rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-3 text-sm text-ink/80">
          Spending is {a.overall.pctOver}% above your typical month — {fmt(a.overall.recent)} in the
          last 30 days vs about {fmt(a.overall.typical)}.
        </li>
      {/if}
      {#each a.categories as cat (cat.code)}
        <li class="rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-3 text-sm text-ink/80">
          {cat.name}: {fmt(cat.recent)} vs about {fmt(cat.typical)} usual ({cat.pctOver}% up).
        </li>
      {/each}
    </ul>
  </section>
{/if}

{#await data.nudges}
  <div class="mt-8 flex items-center gap-2 text-sm text-ink/50">
    <span
      class="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-gold-deep border-t-transparent"
    ></span>
    Reading your cash flow…
  </div>
{:then result}
  {#if result.nudges.length > 0}
    <section class="mt-8">
      <h2 class="font-mono text-xs uppercase tracking-widest text-ink/50">What to watch</h2>
      <ul class="mt-3 space-y-3">
        {#each result.nudges as nudge (nudge.text)}
          <li class="rounded-sm border px-4 py-3 text-sm text-ink/80 {toneClass(nudge.tone)}">
            {nudge.text}
          </li>
        {/each}
      </ul>
    </section>
  {/if}
{/await}

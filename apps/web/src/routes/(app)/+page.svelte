<script lang="ts">
  import { trackEvent } from '$lib/telemetry';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const d = $derived(data.dashboard);

  // Point-in-time count tiles (NOT period-bound — they sit under a "Right now"
  // label, outside the period toggle). Counts only: the money row above already
  // owns the dollar figures, so no $ here avoids a duplicate of "Owed to you".
  // Each tile deep-links to its filtered list. Overdue tints when non-zero —
  // the one metric worth an alert.
  const counts = $derived(data.counts);
  const countTiles = $derived([
    {
      label: 'Overdue',
      count: counts.overdue,
      hint: 'needs chasing',
      href: '/invoices?overdue=true',
      alert: counts.overdue > 0,
    },
    { label: 'Awaiting', count: counts.awaiting, hint: 'not yet due', href: '/invoices?awaiting=true' },
    { label: 'Drafts', count: counts.drafts, hint: 'to send', href: '/invoices?status=draft' },
    {
      label: 'Open estimates',
      count: counts.openEstimates,
      hint: 'awaiting reply',
      href: '/estimates?status=sent',
    },
    // Flagged like an overdue invoice, because it is the same kind of fact: the
    // customer has acted and the business has not. Before this the estimate
    // simply left the tile row when it was accepted (TMC-230).
    {
      label: 'Accepted',
      count: counts.acceptedEstimates,
      hint: 'ready to invoice',
      href: '/estimates?status=accepted',
      alert: counts.acceptedEstimates > 0,
    },
  ]);

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
      ? 'border-danger/30 bg-danger/5'
      : tone === 'good'
        ? 'border-accent/30 bg-accent/5'
        : 'border-fg/15 bg-surface-2';

  // Anomaly flagging (deterministic): unusual spending vs the company's own
  // history. Shown only when something actually flags.
  const a = $derived(data.anomalies);
  const showAnomalies = $derived(a.overall !== null || a.categories.length > 0);

  // ai_insight_viewed (TELEMETRY.md client ingest). Fire per rendered insight
  // surface: the deterministic "Unusual spending" section (anomaly) and the AI
  // "What to watch" nudges (cashflow). trackEvent no-ops server-side / when
  // opted out; re-fires on period change (a fresh view of that period's
  // insights), matching report_viewed's re-fire-on-navigation behaviour.
  $effect(() => {
    if (showAnomalies) trackEvent({ name: 'ai_insight_viewed', insight_type: 'anomaly' });
  });

  $effect(() => {
    // Nudges stream in as a promise; guard against a stale resolution firing
    // after the period changed under it.
    let cancelled = false;
    data.nudges.then((result) => {
      if (!cancelled && result.nudges.length > 0) {
        trackEvent({ name: 'ai_insight_viewed', insight_type: 'cashflow' });
      }
    });
    return () => {
      cancelled = true;
    };
  });
</script>

<span class="eyebrow text-fg/60">{data.companyName}</span>
<h1 class="mt-2 font-serif text-4xl font-light leading-none tracking-tight text-fg">
  Where you stand<span class="text-accent">.</span>
</h1>

<div class="mt-6 flex flex-wrap gap-2">
  {#each periods as p (p.key)}
    <a
      href="/?period={p.key}"
      class="rounded-sm border px-3 py-1 font-mono text-xs uppercase tracking-widest transition-colors {data.period ===
      p.key
        ? 'border-accent text-accent'
        : 'border-fg/15 text-fg/60 hover:border-fg/40 hover:text-fg'}"
    >
      {p.label}
    </a>
  {/each}
</div>

{#if data.pendingInvites > 0}
  <a
    href="/select-company"
    class="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-sm border border-accent/30 bg-accent/5 px-4 py-3 text-sm text-fg transition-colors hover:bg-accent/10"
  >
    <span>
      You have {data.pendingInvites} pending workspace {data.pendingInvites === 1
        ? 'invitation'
        : 'invitations'}.
    </span>
    <span class="font-mono text-xs uppercase tracking-widest text-accent">Review →</span>
  </a>
{/if}

{#if data.needsBusinessDetails}
  <a
    href="/settings/business"
    class="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-sm border border-accent/30 bg-accent/5 px-4 py-3 text-sm text-fg transition-colors hover:bg-accent/10"
  >
    <span>Add your business address so it shows on the invoices your contacts see.</span>
    <span class="font-mono text-xs uppercase tracking-widest text-accent">Add details →</span>
  </a>
{/if}

<dl class="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
  <div class="rounded-sm border border-fg/10 bg-surface-2 p-6">
    <dt class="label">Money in</dt>
    <dd class="mt-2 font-serif text-3xl font-light tabular-nums text-fg">{fmt(d.moneyIn)}</dd>
    <p class="mt-1 text-xs text-fg/40">{flowLabel}</p>
  </div>
  <div class="rounded-sm border border-fg/10 bg-surface-2 p-6">
    <dt class="label">Money out</dt>
    <dd class="mt-2 font-serif text-3xl font-light tabular-nums text-fg">{fmt(d.moneyOut)}</dd>
    <p class="mt-1 text-xs text-fg/40">{flowLabel}</p>
  </div>
  <div class="rounded-sm border border-fg/10 bg-surface-2 p-6">
    <dt class="label">Owed to you</dt>
    <dd class="mt-2 font-serif text-3xl font-light tabular-nums text-fg">{fmt(d.owed)}</dd>
    <p class="mt-1 text-xs text-fg/40">outstanding now</p>
  </div>
  <a href="/bills" class="rounded-sm border border-fg/10 bg-surface-2 p-6 transition-colors hover:border-fg/25">
    <dt class="label">Owed by you</dt>
    <dd class="mt-2 font-serif text-3xl font-light tabular-nums text-fg">{fmt(d.owing)}</dd>
    <p class="mt-1 text-xs text-fg/40">unpaid bills</p>
  </a>
</dl>

<h2 class="label mt-8 text-fg/60">Right now</h2>
<dl class="mt-3 grid grid-cols-2 gap-4 lg:grid-cols-4">
  {#each countTiles as t (t.label)}
    <a
      href={t.href}
      class="rounded-sm border p-4 transition-colors {t.alert
        ? 'border-danger/30 bg-danger/5 hover:border-danger/50'
        : 'border-fg/10 bg-surface-2 hover:border-fg/25'}"
    >
      <dt class="label">{t.label}</dt>
      <dd class="mt-1 font-serif text-2xl font-light tabular-nums text-fg">{t.count}</dd>
      <p class="mt-1 text-xs text-fg/40">{t.hint}</p>
    </a>
  {/each}
</dl>

{#if showAnomalies}
  <section class="mt-8">
    <h2 class="label">Unusual spending</h2>
    <ul class="mt-3 space-y-3">
      {#if a.overall}
        <li class="rounded-sm border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-fg/80">
          Spending is {a.overall.pctOver}% above your typical month — {fmt(a.overall.recent)} in the
          last 30 days vs about {fmt(a.overall.typical)}.
        </li>
      {/if}
      {#each a.categories as cat (cat.code)}
        <li class="rounded-sm border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-fg/80">
          {cat.name}: {fmt(cat.recent)} vs about {fmt(cat.typical)} usual ({cat.pctOver}% up).
        </li>
      {/each}
    </ul>
  </section>
{/if}

{#await data.nudges}
  <div class="mt-8 flex items-center gap-2 text-sm text-fg/50">
    <span
      class="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent border-t-transparent"
    ></span>
    Reading your cash flow…
  </div>
{:then result}
  {#if result.nudges.length > 0}
    <section class="mt-8">
      <h2 class="label">What to watch</h2>
      <ul class="mt-3 space-y-3">
        {#each result.nudges as nudge (nudge.text)}
          <li class="rounded-sm border px-4 py-3 text-sm text-fg/80 {toneClass(nudge.tone)}">
            {nudge.text}
          </li>
        {/each}
      </ul>
    </section>
  {/if}
{/await}

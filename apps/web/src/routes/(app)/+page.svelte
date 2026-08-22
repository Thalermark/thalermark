<script lang="ts">
  import { Sparkline } from '$lib/charts';
  import { may } from '$lib/perms';
  import { trackEvent } from '$lib/telemetry';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const d = $derived(data.dashboard);

  // Server-side and keyed on existence, not on money: a contact, an invoice or
  // an estimate retires the getting-started panel, so a draft invoice counts and
  // a seasonal business in a quiet January does not regress to it (TMC-234).
  const isNew = $derived(d.isNewCompany);

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
    // Only shown when something is wrong. A permanent "0 undelivered" tile
    // would be one more number to ignore; a tile that appears only when an
    // email did not arrive is the whole point (TMC-226).
    ...(counts.undelivered > 0
      ? [
          {
            label: 'Not delivered',
            count: counts.undelivered,
            hint: 'email did not arrive',
            href: '/invoices?undelivered=true',
            alert: true,
          },
        ]
      : []),
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
  // Late-payer detection (deterministic, TMC-262). Ranked worst-first by what is
  // overdue; empty when nobody owes anything late and nobody has a late history,
  // which is the healthy case and shows nothing at all.
  const latePayers = $derived(data.latePayers);

  // The same omission rules the advisor prompt uses, for the same reason: one
  // settled invoice is not a pattern, and a contact listed on history alone has
  // no open invoice to be days past due on. Saying either anyway is a confident
  // sentence about something the data does not support.
  function chaseLine(p: (typeof latePayers)[number]): string {
    const parts = [`${fmt(p.outstanding)} outstanding`];
    if (p.maxDaysPastDue !== null) parts.push(`${p.maxDaysPastDue} days past due`);
    if (p.paidCount >= 2 && p.lateCount > 0) {
      parts.push(`paid late ${p.lateCount} of ${p.paidCount} times`);
    }
    return parts.join(' · ');
  }

  $effect(() => {
    if (showAnomalies) trackEvent({ name: 'ai_insight_viewed', insight_type: 'anomaly' });
  });

  // 'late_payer' was already in the AI_INSIGHT_TYPES taxonomy (validation +
  // telemetry) and had never had a surface to fire from — the feature it was
  // named for did not exist until TMC-262.
  $effect(() => {
    if (latePayers.length > 0) trackEvent({ name: 'ai_insight_viewed', insight_type: 'late_payer' });
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

{#if !isNew}
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
{/if}

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

{#if isNew}
  <!--
    A company with no contact, no invoice and no estimate has nothing this page
    can answer, and four $0.00 tiles over four 0 counts answered it anyway. The
    only call to action on the whole screen was the address nag, which points at
    Settings — so the first thing the product asked a new user to do was
    paperwork (TMC-234).

    The flag is server-side (dashboard.isNewCompany) and keyed on existence
    rather than on money, so a first invoice still sitting in draft is enough to
    retire this panel, and a seasonal business looking at a quiet January never
    sees it.
  -->
  <section class="mt-8 rounded-sm border border-fg/10 bg-surface-2 px-6 py-10">
    <span class="eyebrow text-accent">First steps</span>
    <h2 class="mt-3 font-serif text-3xl font-light leading-tight tracking-tight text-fg">
      Let's get you paid<span class="text-accent">.</span>
    </h2>
    <p class="mt-4 max-w-xl text-fg/70">
      Thalermark keeps the books in the background. Send an invoice, log what you spend, and the
      accounting takes care of itself.
    </p>
    {#if may(data.role, 'sales:write')}
      <a href="/invoices/new" class="btn mt-6 inline-block px-5 py-3">Send your first invoice</a>
    {/if}
    <p class="mt-5 text-sm text-fg/50">
      {#if may(data.role, 'contacts:write')}
        or <a href="/contacts/new" class="link">add a customer</a>
      {/if}
      {#if may(data.role, 'contacts:write') && may(data.role, 'expenses:write')}
        &middot;
      {/if}
      {#if may(data.role, 'expenses:write')}
        <a href="/expenses/new" class="link">record something you bought</a>
      {/if}
    </p>
  </section>
{:else}
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

<!--
  Its OWN row, with its own label, deliberately not inside the "Money in" tile.
  It was there first and it was misleading: "Money in" is CASH RECEIVED in the
  selected period (cashFlowNet), while this is REVENUE BILLED by the month it
  was issued. A trend line sitting under a number is read as that number's
  history, so a $200 cash month with a line peaking at a $6,000 billing month
  invited exactly the wrong conclusion — in an accounting product, of all
  places. Separated and labelled, it says only what it measures. It is also
  always twelve months, where the tiles follow the period toggle.
-->
{#if data.revenueTrend.length > 1}
  <a
    href="/reports/revenue-over-time"
    class="mt-6 flex items-end gap-6 rounded-sm border border-fg/10 bg-surface-2 p-5 transition-colors hover:border-fg/25"
  >
    <div class="shrink-0">
      <span class="label">Billed by month</span>
      <p class="mt-1 text-xs text-fg/40">last 12 months</p>
    </div>
    <div class="min-w-0 flex-1">
      <Sparkline values={data.revenueTrend} label="Revenue billed by month, last 12 months" />
    </div>
  </a>
{/if}

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
{/if}

{#if latePayers.length > 0}
  <!--
    Above "Unusual spending" on purpose. Both are deterministic and free, but
    chasing money already earned is a higher-value action than noticing money
    spent, and this is the only surface in the product that answers "who do I
    call" without the operator first suspecting someone and opening their page.
  -->
  <section class="mt-8">
    <h2 class="label">Who to chase</h2>
    <ul class="mt-3 space-y-3">
      {#each latePayers as p (p.contactId)}
        <li
          class="rounded-sm border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-fg/80 transition-colors hover:border-danger/50"
        >
          <a href="/contacts/{p.contactId}" class="block">
            <span class="font-medium text-fg">{p.name}</span>
            <span class="mt-0.5 block text-fg/70">{chaseLine(p)}</span>
          </a>
        </li>
      {/each}
    </ul>
  </section>
{/if}

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
    <!--
      Labelled with its own window, for the same reason the revenue sparkline
      above carries "last 12 months": the tiles follow the period toggle and this
      does not. The nudge signals are always month-to-date (reports.ts builds
      monthToDate plus three trailing months, and takes no period argument), so
      on the "this year" toggle a tile read $84,000 while the nudge under it said
      $6,200. Both figures are right and together they read as the product
      contradicting itself — on the one feature people pay for, whose whole
      architecture rests on the model quoting ledger figures rather than
      inventing them (TMC-229).

      Making the nudge follow the toggle is the fuller answer and is deliberately
      NOT done here: companies.cash_flow_nudges is a single cached value per
      company, so three toggle states sharing one slot would regenerate on every
      switch and triple the model spend for one page view.

      TMC-229 HAS NOW LANDED and did not change that call — one cache slot per
      company, still month-to-date. What it did instead was make the prompt name
      the period in the sentence itself ("SAY WHICH stretch, in the same words
      used below"), so the nudge now carries its own window in its text as well
      as in this label. Two independent statements of the same fact, which is
      what a figure sitting next to a differently-scoped tile needs.
    -->
    <section class="mt-8">
      <h2 class="label">What to watch</h2>
      <p class="mt-1 text-xs text-fg/40">this month so far</p>
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

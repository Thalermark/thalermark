<script lang="ts">
  import { ColumnChart, ShareBar } from '$lib/charts';
  import AuditHistory from '$lib/components/AuditHistory.svelte';
  import MetricStrip from '$lib/components/MetricStrip.svelte';
  import { may } from '$lib/perms';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const c = $derived(data.contact);

  // Role gate (UX only — the API is authoritative). Editing a contact is
  // `contacts:write`; the statement is a read and stays open to every role.
  const canWrite = $derived(may(data.role, 'contacts:write'));

  const addressLines = $derived(
    [
      c.addressLine1,
      c.addressLine2,
      [c.city, c.region, c.postalCode].filter(Boolean).join(', ') || null,
      c.country,
    ].filter((line): line is string => Boolean(line)),
  );

  const fmt = (s: string) =>
    Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  // Payment reliability (late-payer detection). Needs at least 2 paid invoices
  // to state a pattern; below that we only surface a live overdue warning, if
  // any. The headline + tone are derived from the deterministic API figures.
  const r = $derived(data.reliability);
  const reliability = $derived.by(() => {
    if (!r) return null;
    const overdue =
      r.overdueCount > 0
        ? `${r.overdueCount} invoice${r.overdueCount === 1 ? '' : 's'} overdue now (${fmt(r.overdueTotal)})`
        : null;
    if (r.paidCount < 2) {
      return overdue ? { headline: overdue, tone: 'warning' as const } : null;
    }
    if (r.lateCount === 0) {
      return { headline: `Always pays on time (${r.paidCount} invoices)`, tone: 'good' as const };
    }
    const days =
      r.avgDaysLate && r.avgDaysLate > 0
        ? ` — about ${r.avgDaysLate} ${r.avgDaysLate === 1 ? 'day' : 'days'} past due`
        : '';
    return {
      headline: `Pays late ${r.lateCount} of ${r.paidCount} times${days}`,
      tone: (r.latePct ?? 0) >= 50 ? ('warning' as const) : ('info' as const),
    };
  });

  const toneClass = (tone: string) =>
    tone === 'warning'
      ? 'border-danger/30 bg-danger/5'
      : tone === 'good'
        ? 'border-accent/30 bg-accent/5'
        : 'border-fg/15 bg-surface-2';

  // Customer insights. EVERY BLOCK BELOW HAS A FLOOR and renders nothing beneath
  // it — the collapse rules are the design. A brand-new contact's page must come
  // out exactly as it did before this existed, which is also the easiest way to
  // check the floors are wired: open a contact with no history and compare.
  const ins = $derived(data.insights);

  const tiles = $derived.by(() => {
    if (!ins || ins.billed.invoiceCount === 0) return null;
    const overdue = ins.owed.overdueCount;
    const e = ins.estimates;
    return [
      {
        label: 'Billed',
        value: fmt(ins.billed.last12),
        sub: `${ins.billed.invoiceCount} invoice${ins.billed.invoiceCount === 1 ? '' : 's'}`,
        href: `/invoices?contactId=${c.id}`,
      },
      {
        label: 'Owed now',
        value: fmt(ins.owed.amount),
        sub: overdue > 0 ? `${overdue} overdue` : undefined,
        alert: overdue > 0,
        href: `/invoices?contactId=${c.id}`,
      },
      // Only when this customer has ever been quoted. A tile reading "0 of 0
      // won" is not a zero state, it is a sentence with no meaning — and it
      // sends a click to an empty list.
      ...(e.answered + e.open + e.lapsed > 0
        ? [
            {
              label: 'Estimates',
              value: `${e.accepted} of ${e.answered} won`,
              sub: e.open > 0 ? `${e.open} still out` : undefined,
              href: `/estimates?contactId=${c.id}`,
            },
          ]
        : []),
    ];
  });

  // The on-time share. No bar when nothing was late — a solid green bar reading
  // 100% is noise, and the sentence above it already says so in words.
  const onTimeShare = $derived.by(() => {
    if (!r || r.paidCount < 2 || r.lateCount === 0) return null;
    return r.onTimeCount / r.paidCount;
  });

  // Oldest to newest, because the API returns newest first and a series read
  // left to right has to run forwards in time.
  const recentBilling = $derived([...(ins?.typical.recent ?? [])].reverse());

  const MONTHS = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  // Gap-filled, so a customer who billed nothing in March gets a zero column
  // rather than the chart silently closing the gap and implying continuous work.
  // The same trap the dashboard sparkline fell into.
  const monthSeries = $derived.by(() => {
    const rows = ins?.months ?? [];
    if (rows.length === 0) return [];
    const byMonth = new Map(rows.map((m) => [m.month, m.billed]));
    const first = rows[0]?.month ?? '';
    const last = rows[rows.length - 1]?.month ?? first;
    const out: { month: string; billed: string }[] = [];
    let [y, m] = first.split('-').map(Number) as [number, number];
    const [ly, lm] = last.split('-').map(Number) as [number, number];
    for (let i = 0; i < 24 && (y < ly || (y === ly && m <= lm)); i++) {
      const key = `${y}-${String(m).padStart(2, '0')}`;
      out.push({ month: key, billed: byMonth.get(key) ?? '0.00' });
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
    return out;
  });
  // Two bars is not a trend, it is a pair of numbers, and the strip already
  // shows the bigger one.
  const showMonths = $derived(monthSeries.filter((m) => Number(m.billed) > 0).length >= 3);
  const spansYears = $derived(new Set(monthSeries.map((m) => m.month.slice(0, 4))).size > 1);
  const monthTick = (key: string) => {
    const [y, m] = key.split('-').map(Number);
    const name = MONTHS[(m ?? 1) - 1];
    return spansYears ? `${name} ${String(y).slice(2)}` : (name ?? key);
  };
</script>

<a href="/contacts" class="eyebrow text-fg/60 hover:text-fg">← Contacts</a>
<div class="mt-3 flex items-baseline justify-between gap-6">
  <h1 class="font-serif text-4xl font-light leading-none tracking-tight text-fg">
    {c.name}<span class="text-accent">.</span>
  </h1>
  <div class="flex items-center gap-2">
    <a
      href="/contacts/{c.id}/statement"
      class="rounded-sm border border-fg/20 px-3 py-1 font-mono text-xs uppercase tracking-widest text-fg/70 hover:border-accent hover:text-accent"
    >
      Statement
    </a>
    {#if canWrite}
      <a
        href="/contacts/{c.id}/edit"
        class="rounded-sm border border-fg/20 px-3 py-1 font-mono text-xs uppercase tracking-widest text-fg/70 hover:border-accent hover:text-accent"
      >
        Edit
      </a>
      <!--
        Archive, not delete. There is no delete: an invoice keeps naming who it
        was billed to, so a contact with any history can never go away. This
        takes the name out of the pickers and nothing else, and the button that
        replaces it puts it straight back.
      -->
      <form method="post" action={c.archivedAt ? '?/restore' : '?/archive'}>
        <button
          type="submit"
          class="rounded-sm border border-fg/20 px-3 py-1 font-mono text-xs uppercase tracking-widest text-fg/70 hover:border-accent hover:text-accent"
        >
          {c.archivedAt ? 'Restore' : 'Archive'}
        </button>
      </form>
    {/if}
  </div>
</div>

{#if c.archivedAt}
  <p class="mt-4 rounded-sm border border-fg/15 bg-surface-2 px-4 py-3 text-sm text-fg/70">
    Archived — hidden from the customer and vendor pickers. Existing invoices,
    estimates and expenses are untouched and still name them.
  </p>
{/if}

{#if tiles}
  <div class="mt-8">
    <MetricStrip {tiles} />
  </div>
{/if}

<dl class="mt-8 grid grid-cols-1 gap-x-12 gap-y-6 sm:grid-cols-2">
  {#if c.email}
    <div>
      <dt class="label">Email</dt>
      <dd class="mt-1 text-fg">{c.email}</dd>
    </div>
  {/if}
  {#if c.phone}
    <div>
      <dt class="label">Phone</dt>
      <dd class="mt-1 text-fg">{c.phone}</dd>
    </div>
  {/if}
  {#if addressLines.length > 0}
    <div class="sm:col-span-2">
      <dt class="label">Address</dt>
      <dd class="mt-1 text-fg">
        {#each addressLines as line, i (i)}
          <div>{line}</div>
        {/each}
      </dd>
    </div>
  {/if}
  {#if c.notes}
    <div class="sm:col-span-2">
      <dt class="label">Notes</dt>
      <dd class="mt-1 whitespace-pre-wrap text-fg/80">{c.notes}</dd>
    </div>
  {/if}
</dl>

{#if reliability}
  <section class="mt-8">
    <h2 class="label">Payment reliability</h2>
    <p class="mt-3 rounded-sm border px-4 py-3 text-sm text-fg/80 {toneClass(reliability.tone)}">
      {reliability.headline}
    </p>
    {#if r && r.paidCount >= 2 && r.overdueCount > 0}
      <p
        class="mt-2 rounded-sm border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-fg/80"
      >
        {r.overdueCount} invoice{r.overdueCount === 1 ? '' : 's'} overdue now ({fmt(r.overdueTotal)})
      </p>
    {/if}
    {#if onTimeShare !== null && r}
      <div class="mt-3 max-w-sm">
        <ShareBar value={onTimeShare} tone="positive" showPercent={false} />
        <p class="mt-1.5 font-mono text-xs tabular-nums text-fg/50">
          {r.onTimeCount} on time · {r.lateCount} late
        </p>
      </div>
    {/if}
  </section>
{/if}

<!--
  What you usually bill them. The number is the insight; the line beneath it is
  the spread. Deliberately no trend arrow and no percentage — the send-check's
  design note is that it states two figures and lets the person who did the work
  decide, and this is the same fact stated in the open instead of only when it
  trips.
-->
{#if ins && ins.typical.median && recentBilling.length >= 3}
  <section class="mt-8">
    <h2 class="label">What you usually bill them</h2>
    <div class="mt-3 rounded-sm border border-fg/10 bg-surface-2 px-4 py-4">
      <p class="font-serif text-3xl font-light tabular-nums text-fg">
        {fmt(ins.typical.median)}
      </p>
      <!--
        The amounts themselves, not a sparkline of them. Five points make a
        shape that reads as a trend, and these are not a time series in any
        useful sense — they are the last few jobs, which vary because jobs vary.
        The question is "is this one normal", and a list of what the others cost
        answers it directly where a squiggle does not.
      -->
      <p class="mt-2 font-mono text-xs tabular-nums text-fg/50">
        {recentBilling.map(fmt).join('  ·  ')}
      </p>
      <p class="mt-1 font-mono text-xs uppercase tracking-widest text-fg/40">
        Last {recentBilling.length} invoices, oldest first
      </p>
    </div>
  </section>
{/if}

{#if ins && showMonths}
  <section class="mt-8">
    <h2 class="label">Billed by month</h2>
    <p class="mt-1 text-sm text-fg/60">
      Last 12 months. Pre-tax, from sent or paid invoices.
    </p>
    <div class="mt-3">
      <ColumnChart
        data={monthSeries}
        x={{ key: 'month', label: (m) => monthTick(m.month), title: 'Month' }}
        series={[{ key: 'billed', label: 'Billed' }]}
        caption="What {c.name} was billed each month over the last 12 months."
        height={160}
      />
    </div>
  </section>
{/if}

<!--
  Estimates. The accept rate is off ANSWERED quotes only. A quote that expired
  unanswered is not a "no" — the customer said nothing, and the expiry date was
  the operator's own choice, so counting it would move this rate because someone
  typed 30 days instead of 90. Lapsed is reported beside it as its own fact.
-->
{#if ins && ins.estimates.answered > 0}
  <section class="mt-8">
    <h2 class="label">Estimates</h2>
    <div class="mt-3 max-w-sm">
      <p class="text-sm text-fg/80">
        {ins.estimates.accepted} of {ins.estimates.answered} accepted
      </p>
      <div class="mt-2">
        <ShareBar
          value={ins.estimates.accepted / ins.estimates.answered}
          tone="positive"
          showPercent={ins.estimates.answered >= 4}
        />
      </div>
      {#if ins.estimates.lapsed > 0}
        <p class="mt-1.5 font-mono text-xs tabular-nums text-fg/50">
          {ins.estimates.lapsed} expired without an answer
        </p>
      {/if}
    </div>
  </section>
{/if}

<AuditHistory events={data.auditEvents} />

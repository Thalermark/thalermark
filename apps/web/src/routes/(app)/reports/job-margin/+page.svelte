<script lang="ts">
  import ExportCsvButton from '$lib/components/ExportCsvButton.svelte';
  import PeriodSelector from '$lib/components/PeriodSelector.svelte';
  import type { CsvCell } from '$lib/csv';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const { report, presets, activeKey } = $derived(data);

  const fmt = (s: string) =>
    Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  const shared = $derived(Number(report.totals.shared));
  const unattributed = $derived(Number(report.totals.unattributed));

  // Named jobs and bare invoices render as one list — both are "a job" to the
  // person reading this. A named job may own several invoices, so it has no
  // single number or date to show; an invoice standing in as its own job has no
  // tracked hours. Flattening them here keeps the table markup single-purpose.
  type Row = {
    key: string;
    href: string;
    title: string;
    tag: string | null;
    date: string;
    billed: string;
    // Written but not sent. Null on rows that cannot have one.
    drafted: string | null;
    costs: string;
    // Null when the job has recognised no revenue yet — its costs are work in
    // progress and there is no margin to state (TMC-203).
    made: string | null;
    hours: string | null;
    perHour: string | null;
    ready: string | null;
  };

  const rows = $derived<Row[]>([
    ...report.jobs.map((j) => ({
      key: `job:${j.jobId}`,
      href: `/jobs/${j.jobId}`,
      title: j.name,
      tag: j.customerName,
      date: '—',
      billed: j.billed,
      drafted: Number(j.drafted) > 0 ? j.drafted : null,
      costs: j.costs,
      made: j.made,
      hours: j.minutes > 0 ? j.hours : null,
      perHour: j.effectiveHourly,
      ready: Number(j.readyToBill) > 0 ? j.readyToBill : null,
    })),
    ...report.unjobbedInvoices.map((inv) => ({
      key: `invoice:${inv.invoiceId}`,
      href: `/invoices/${inv.invoiceId}`,
      title: inv.customerName ?? '—',
      tag: inv.number,
      date: inv.issueDate,
      billed: inv.billed,
      // An unjobbed row is a sent or paid invoice by definition — the report's
      // window never admits a draft as its own row, because its subtotal would
      // read as recognised revenue.
      drafted: null,
      costs: inv.costs,
      made: inv.made,
      hours: null,
      perHour: null,
      // An invoice standing in as its own job has no tracked hours by
      // definition, so nothing can be waiting on it.
      ready: null,
    })),
  ]);

  const csvRows = $derived<CsvCell[][]>([
    [
      'Job',
      'Customer or number',
      'Date',
      'Hours',
      'Billed',
      'Drafted',
      'Costs',
      'Made',
      'Per hour',
      'Ready to bill',
    ],
    ...rows.map(
      (r) =>
        [
          r.title,
          r.tag ?? '',
          r.date === '—' ? '' : r.date,
          r.hours ?? '',
          r.billed,
          r.drafted ?? '',
          r.costs,
          // Empty, never 0 — a spreadsheet would sum a zero into a total that
          // is not true. No recognised revenue means no margin to state.
          r.made ?? '',
          r.perHour ?? '',
          r.ready ?? '',
        ] as CsvCell[],
    ),
    ['Shared costs', '', '', '', '', '', report.totals.shared, '', '', ''],
    ['Work in progress', '', '', '', '', '', report.totals.workInProgress, '', '', ''],
    [
      'Total',
      '',
      '',
      report.totals.hours,
      report.totals.billed,
      report.totals.drafted,
      report.totals.jobCosts,
      report.totals.made,
      '',
      report.totals.readyToBill,
    ],
  ]);
</script>

<div class="flex flex-wrap items-baseline justify-between gap-6">
  <div>
    <a href="/reports" class="eyebrow text-fg/60 hover:text-fg">← Reports</a>
    <h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-fg">
      What each job made<span class="text-accent">.</span>
    </h1>
  </div>
  <ExportCsvButton
    filename="job-margin_{report.from}_{report.to}"
    rows={csvRows}
    disabled={rows.length === 0}
  />
</div>

<PeriodSelector {presets} {activeKey} from={report.from} to={report.to} />

<p class="mt-4 text-sm text-fg/60">
  {report.from} → {report.to}. Billed is pre-tax. Costs are the ones you said were for that job —
  tag a receipt with a job to see it here. Per hour is what the job paid for the time you logged
  against it.
</p>

{#if rows.length === 0}
  <p class="mt-8 text-fg/70">No sent invoices in this period.</p>
{:else}
  <div class="mt-8 overflow-x-auto rounded-sm border border-fg/10 bg-surface-2">
    <table class="w-full text-left text-sm">
      <thead class="bg-surface">
        <tr class="label">
          <th class="px-5 py-3">Job</th>
          <th class="px-5 py-3">Date</th>
          <th class="w-24 px-5 py-3 text-right">Hours</th>
          <th class="w-32 px-5 py-3 text-right">Billed</th>
          <th class="w-32 px-5 py-3 text-right">Drafted</th>
          <th class="w-32 px-5 py-3 text-right">Costs</th>
          <th class="w-32 px-5 py-3 text-right">Made</th>
          <th class="w-32 px-5 py-3 text-right">Per hour</th>
          <th class="w-32 px-5 py-3 text-right">Ready</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-fg/10">
        {#each rows as r (r.key)}
          <tr>
            <td class="px-5 py-3">
              <a href={r.href} class="text-fg hover:text-accent">{r.title}</a>
              {#if r.tag}
                <span class="ml-2 font-mono text-xs text-fg/40">{r.tag}</span>
              {/if}
            </td>
            <td class="px-5 py-3 text-fg/60">{r.date}</td>
            <td class="px-5 py-3 text-right font-mono tabular-nums text-fg/60">
              {r.hours ?? '—'}
            </td>
            <td class="px-5 py-3 text-right font-mono tabular-nums text-fg/70">{fmt(r.billed)}</td>
            <td class="px-5 py-3 text-right font-mono tabular-nums text-fg/70">
              {r.drafted ? fmt(r.drafted) : '—'}
            </td>
            <td class="px-5 py-3 text-right font-mono tabular-nums text-fg/70">
              {Number(r.costs) > 0 ? `−${fmt(r.costs)}` : '—'}
            </td>
            <!--
              A dash until something is billed. `billed - costs` with nothing
              billed is the negative of the costs, and printing that told a
              landscaper he had LOST the price of the plants on a job he simply
              had not invoiced yet. Those costs are work in progress; the loss
              was never real.
            -->
            <td class="px-5 py-3 text-right font-mono tabular-nums text-fg">
              {r.made === null ? '—' : fmt(r.made)}
            </td>
            <!--
              Blank, not zero, when no time was logged. A dash reads as "you
              didn't tell me"; $0.00/hr reads as "this job paid you nothing".
            -->
            <td class="px-5 py-3 text-right font-mono tabular-nums text-fg/70">
              {r.perHour ? `${fmt(r.perHour)}/hr` : '—'}
            </td>
            <!--
              Work done and not yet charged for. Deliberately NOT folded into
              made — that would inflate the bottom line with money nobody has
              been invoiced for.
            -->
            <td class="px-5 py-3 text-right font-mono tabular-nums text-accent">
              {r.ready ? fmt(r.ready) : '—'}
            </td>
          </tr>
        {/each}
      </tbody>
      <tfoot class="border-t border-fg/10 bg-surface">
        <!--
          Shared costs get their own line and are never spread across the jobs
          above. Splitting a cost the user declined to split would invent a
          precision he never gave, and he would trust the number.
        -->
        {#if shared > 0}
          <tr class="text-fg/70">
            <td class="px-5 py-3" colspan="5">
              Shared costs
              <span class="ml-2 text-xs text-fg/50">not counted against any one job</span>
            </td>
            <td class="px-5 py-3 text-right font-mono tabular-nums">−{fmt(report.totals.shared)}</td>
            <td></td>
            <td></td>
            <td></td>
          </tr>
        {/if}
        <!--
          Costs on jobs that have recognised no revenue yet. Held OUT of the made
          total below, for the same reason those rows show no margin — charging
          the period for work whose revenue hasn't landed would make the bottom
          line contradict the rows above it. Shown rather than netted silently,
          so made = billed − (costs − work in progress) can be checked by eye.
        -->
        {#if Number(report.totals.workInProgress) > 0}
          <tr class="text-fg/70">
            <td class="px-5 py-3" colspan="5">
              Work in progress
              <span class="ml-2 text-xs text-fg/50">
                spent on jobs that haven't billed yet, so not counted against this period
              </span>
            </td>
            <td class="px-5 py-3 text-right font-mono tabular-nums">
              +{fmt(report.totals.workInProgress)}
            </td>
            <td></td>
            <td></td>
            <td></td>
          </tr>
        {/if}
        <tr class="font-mono text-xs uppercase tracking-widest">
          <td class="px-5 py-3 text-fg/70" colspan="2">Total</td>
          <td class="px-5 py-3 text-right tabular-nums text-fg/70">
            {report.totals.minutes > 0 ? report.totals.hours : '—'}
          </td>
          <td class="px-5 py-3 text-right tabular-nums text-fg/70">{fmt(report.totals.billed)}</td>
          <td class="px-5 py-3 text-right tabular-nums text-fg/70">
            {Number(report.totals.drafted) > 0 ? fmt(report.totals.drafted) : '—'}
          </td>
          <td class="px-5 py-3 text-right tabular-nums text-fg/70">
            −{fmt(report.totals.jobCosts)}
          </td>
          <td class="px-5 py-3 text-right text-base tabular-nums text-fg">
            {fmt(report.totals.made)}
          </td>
          <td></td>
          <!--
            Sits outside the made total on purpose: this is work done and not yet
            charged for, so adding it in would inflate the bottom line with money
            nobody has been invoiced for.
          -->
          <td class="px-5 py-3 text-right tabular-nums text-accent">
            {Number(report.totals.readyToBill) > 0 ? fmt(report.totals.readyToBill) : '—'}
          </td>
        </tr>
      </tfoot>
    </table>
  </div>

  <!--
    Costs he never answered for. Shown rather than hidden so the totals here
    can be reconciled against the P&L instead of quietly disagreeing with it.
  -->
  {#if unattributed > 0}
    <p class="mt-4 text-sm text-fg/60">
      {fmt(report.totals.unattributed)} of spending in this period isn't tagged to a job yet, so it
      isn't in the numbers above. Open an expense and answer “what was this for?” to include it.
    </p>
  {/if}
{/if}

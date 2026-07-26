<script lang="ts">
  import ExportCsvButton from '$lib/components/ExportCsvButton.svelte';
  import type { CsvCell } from '$lib/csv';
  import type { PageProps } from './$types';

  // Schedule C worksheet. Deliberately laid out like the IRS form rather than
  // like our other reports — someone copying figures across should be able to
  // read down it line by line. Print-friendly (same window.print() approach as
  // the customer statement) because the common use is handing it to a preparer.
  let { data }: PageProps = $props();

  const { report, years } = $derived(data);

  const fmt = (s: string) =>
    Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  // Query-string links rather than a form — keeps the page bookmarkable and
  // shareable at an exact year/basis, and needs no client state.
  const hrefFor = (opts: { year?: number; basis?: string }) => {
    const p = new URLSearchParams({
      year: String(opts.year ?? report.year),
      basis: opts.basis ?? report.basis,
    });
    return `?${p.toString()}`;
  };

  // True when the view was overridden away from the company's saved election —
  // the page has to say so, or Settings and this page silently disagree.
  const overridden = $derived(report.basis !== report.companyAccountingMethod);

  const basisLabel = $derived(
    report.basis === 'cash' ? 'Cash — counted when paid' : 'Accrual — counted when invoiced',
  );

  const hasUnmapped = $derived(report.unmappedExpenses.length > 0);

  const csvRows = $derived<CsvCell[][]>([
    ['Schedule C worksheet', `${report.year}`, `${report.basis} basis`],
    ['Period', report.from, report.to],
    [],
    ['Part', 'Line', 'Description', 'Amount'],
    ['I', '1', 'Gross receipts or sales', report.partI.grossReceipts],
    ['I', '2', 'Returns and allowances', report.partI.returnsAndAllowances],
    ['I', '4', 'Cost of goods sold', report.partI.costOfGoodsSold],
    ['I', '6', 'Other income', report.partI.otherIncome],
    ['I', '7', 'Gross income', report.partI.grossIncome],
    ...report.partII.map(
      (r) =>
        ['II', r.line, r.userSupplied ? `${r.label} (you must supply)` : r.label, r.amount] as CsvCell[],
    ),
    ...report.unmappedExpenses.map(
      (a) => ['II', '', `UNMAPPED — ${a.code} ${a.name}`, a.amount] as CsvCell[],
    ),
    ['', '28', 'Total expenses', report.totalExpenses],
    ['', '29', 'Tentative profit or loss', report.tentativeProfit],
    ['', '30', 'Expenses for business use of your home (you must supply)', ''],
    ['', '31', 'Net profit or loss (before line 30)', report.netProfit],
  ]);
</script>

<!-- Toolbar — hidden when printing. -->
<div class="flex flex-wrap items-baseline justify-between gap-6 print:hidden">
  <div>
    <a href="/reports" class="eyebrow text-fg/60 hover:text-fg">← Reports</a>
    <h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-fg">
      Schedule C<span class="text-accent">.</span>
    </h1>
  </div>
  <div class="flex flex-wrap items-center gap-3">
    <button
      type="button"
      onclick={() => window.print()}
      class="inline-flex items-center gap-2 rounded-sm border border-fg/15 bg-surface-2 px-4 py-2 text-sm font-medium text-fg transition-colors hover:border-accent/40 hover:text-accent"
    >
      Print / save PDF
    </button>
    <ExportCsvButton filename="schedule-c_{report.year}_{report.basis}" rows={csvRows} />
  </div>
</div>

<!-- Year + basis pickers. -->
<div class="mt-6 flex flex-wrap items-center gap-x-8 gap-y-3 print:hidden">
  <div class="flex items-center gap-2">
    <span class="label">Tax year</span>
    {#each years as y (y)}
      <a
        href={hrefFor({ year: y })}
        class="rounded-sm border px-3 py-1 text-sm transition-colors {y === report.year
          ? 'border-accent bg-accent/10 text-accent'
          : 'border-fg/15 text-fg/70 hover:border-accent/40 hover:text-accent'}"
      >
        {y}
      </a>
    {/each}
  </div>
  <div class="flex items-center gap-2">
    <span class="label">Counting</span>
    {#each [['cash', 'When paid'], ['accrual', 'When invoiced']] as [value, label] (value)}
      <a
        href={hrefFor({ basis: value })}
        class="rounded-sm border px-3 py-1 text-sm transition-colors {value === report.basis
          ? 'border-accent bg-accent/10 text-accent'
          : 'border-fg/15 text-fg/70 hover:border-accent/40 hover:text-accent'}"
      >
        {label}
      </a>
    {/each}
  </div>
</div>

{#if overridden}
  <p class="mt-4 callout print:hidden">
    You're viewing <strong>{report.basis}</strong> figures, but this business is set to
    <strong>{report.companyAccountingMethod}</strong>. Change the saved setting in
    <a href="/settings/business" class="link">Settings → Business</a> if that's wrong.
  </p>
{/if}

<article class="mt-6 rounded-sm border border-fg/10 bg-surface-2 p-8 print:border-0 print:bg-white print:p-0">
  <header class="border-b border-fg/10 pb-5">
    <h2 class="font-serif text-2xl font-light text-fg">
      Schedule C worksheet — {report.year}
    </h2>
    <p class="mt-1 text-sm text-fg/60">
      {report.from} → {report.to} · {basisLabel}
    </p>
  </header>

  <!-- Part I. Lines 2/4/6 have no data model (no refunds, no inventory) but
       render at zero so the form reads whole rather than abridged. -->
  <section class="mt-6">
    <h3 class="label">Part I — Income</h3>
    <table class="mt-3 w-full text-left text-sm">
      <tbody class="divide-y divide-fg/10">
        <tr>
          <td class="py-2 pr-4 font-mono text-xs text-fg/40">1</td>
          <td class="py-2 text-fg/80">Gross receipts or sales</td>
          <td class="w-36 py-2 text-right font-mono tabular-nums text-fg">
            {fmt(report.partI.grossReceipts)}
          </td>
        </tr>
        <tr>
          <td class="py-2 pr-4 font-mono text-xs text-fg/40">2</td>
          <td class="py-2 text-fg/80">Returns and allowances</td>
          <td class="py-2 text-right font-mono tabular-nums text-fg/50">
            {fmt(report.partI.returnsAndAllowances)}
          </td>
        </tr>
        <tr>
          <td class="py-2 pr-4 font-mono text-xs text-fg/40">4</td>
          <td class="py-2 text-fg/80">Cost of goods sold</td>
          <td class="py-2 text-right font-mono tabular-nums text-fg/50">
            {fmt(report.partI.costOfGoodsSold)}
          </td>
        </tr>
        <tr>
          <td class="py-2 pr-4 font-mono text-xs text-fg/40">6</td>
          <td class="py-2 text-fg/80">Other income</td>
          <td class="py-2 text-right font-mono tabular-nums text-fg/50">
            {fmt(report.partI.otherIncome)}
          </td>
        </tr>
        <tr class="font-medium">
          <td class="py-2 pr-4 font-mono text-xs text-fg/40">7</td>
          <td class="py-2 text-fg">Gross income</td>
          <td class="py-2 text-right font-mono tabular-nums text-fg">
            {fmt(report.partI.grossIncome)}
          </td>
        </tr>
      </tbody>
    </table>
  </section>

  <!-- Part II. Every line renders, including the ones we never post to, so the
       output can be read alongside the real form. -->
  <section class="mt-8">
    <h3 class="label">Part II — Expenses</h3>
    <table class="mt-3 w-full text-left text-sm">
      <tbody class="divide-y divide-fg/10">
        {#each report.partII as row (row.line)}
          <tr>
            <td class="w-10 py-2 pr-4 align-top font-mono text-xs text-fg/40">{row.line}</td>
            <td class="py-2">
              <span class={row.amount === '0.00' ? 'text-fg/50' : 'text-fg/80'}>{row.label}</span>
              {#if row.userSupplied}
                <span class="ml-2 text-xs text-accent">you must supply this</span>
              {/if}
              <!-- Show the working when more than one account feeds a line, so
                   an unexpected figure is traceable without leaving the page. -->
              {#if row.accounts.length > 1}
                <span class="mt-0.5 block text-xs text-fg/40">
                  {row.accounts.map((a) => `${a.name} ${fmt(a.amount)}`).join(' · ')}
                </span>
              {/if}
            </td>
            <td
              class="w-36 py-2 text-right align-top font-mono tabular-nums {row.amount === '0.00'
                ? 'text-fg/40'
                : 'text-fg'}"
            >
              {fmt(row.amount)}
            </td>
          </tr>
        {/each}
      </tbody>
      <tfoot class="border-t-2 border-fg/20">
        <tr class="font-medium">
          <td class="py-3 pr-4 font-mono text-xs text-fg/40">28</td>
          <td class="py-3 text-fg">Total expenses</td>
          <td class="py-3 text-right font-mono tabular-nums text-fg">
            {fmt(report.totalExpenses)}
          </td>
        </tr>
        <tr>
          <td class="py-2 pr-4 font-mono text-xs text-fg/40">29</td>
          <td class="py-2 text-fg/80">Tentative profit or loss</td>
          <td class="py-2 text-right font-mono tabular-nums text-fg">
            {fmt(report.tentativeProfit)}
          </td>
        </tr>
        <tr>
          <td class="py-2 pr-4 font-mono text-xs text-fg/40">30</td>
          <td class="py-2 text-fg/50">
            Expenses for business use of your home
            <span class="ml-2 text-xs text-accent">you must supply this</span>
          </td>
          <td class="py-2 text-right font-mono text-fg/40">—</td>
        </tr>
        <tr class="text-base font-medium">
          <td class="py-3 pr-4 font-mono text-xs text-fg/40">31</td>
          <td class="py-3 text-fg">Net profit or loss</td>
          <td class="py-3 text-right font-mono tabular-nums text-fg">
            {fmt(report.netProfit)}
          </td>
        </tr>
      </tfoot>
    </table>
  </section>

  <!-- An account we can't place still counts toward line 28, so it has to be
       visible — otherwise line 28 quietly disagrees with the P&L. -->
  {#if hasUnmapped}
    <section class="mt-8">
      <h3 class="label text-danger">Not mapped to a Schedule C line</h3>
      <p class="mt-2 text-sm text-fg/70">
        These are included in line 28 but we don't know which line they belong on. Review them with
        whoever prepares your return.
      </p>
      <ul class="mt-3 space-y-1 text-sm">
        {#each report.unmappedExpenses as a (a.code)}
          <li class="flex justify-between gap-4">
            <span class="text-fg/80">{a.code} · {a.name}</span>
            <span class="font-mono tabular-nums text-fg">{fmt(a.amount)}</span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <footer class="mt-8 border-t border-fg/10 pt-5 text-xs leading-relaxed text-fg/60">
    <p>
      A worksheet to hand to whoever prepares your return — not a filing, and not tax advice.
      Figures come from your own records on a <strong>{report.basis}</strong> basis.
    </p>
    <p class="mt-2">
      Line 9 (car and truck) and line 30 (business use of your home) are blank because Thalermark
      doesn't track mileage or home-office use — fill those in yourself. Line 31 does not subtract
      line 30. Part III (cost of goods sold) is not included; materials you bill on are recorded
      under supplies, line 22.
    </p>
  </footer>
</article>

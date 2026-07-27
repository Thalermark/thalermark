<script lang="ts">
  import ExportCsvButton from '$lib/components/ExportCsvButton.svelte';
  import type { CsvCell } from '$lib/csv';
  import type { TaxLineRow } from '$lib/reports.server';
  import type { PageProps } from './$types';

  // Tax worksheet. Deliberately laid out like the IRS form rather than like our
  // other reports — someone copying figures across should be able to read down
  // it line by line. Print-friendly (same window.print() approach as the
  // customer statement) because the common use is handing it to a preparer.
  //
  // One page, four forms (TMC-162). The API dispatches on business type and
  // returns that form's own line table, so nothing here branches on entity type.
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

  // The catch-all line. On the 1065 / 1120-S / 1120 more than half the chart
  // lands here, and the IRS wants an itemised statement filed alongside — so it
  // gets its own section below rather than a footnote under the line.
  const itemised = $derived(report.deductions.find((r) => r.itemized));

  // Schedule C's "Part I / Part II" wording only fits Schedule C; the corporate
  // and partnership forms just call them income and deductions.
  const isScheduleC = $derived(report.formCode === 'schedule_c');
  const incomeHeading = $derived(isScheduleC ? 'Part I — Income' : 'Income');
  const deductionsHeading = $derived(isScheduleC ? 'Part II — Expenses' : 'Deductions');

  // An em dash where nothing can fill the line. Never 0.00 for a blank — a zero
  // reads as "you had none of this".
  const amountOf = (r: TaxLineRow) => (r.amount === null ? '—' : fmt(r.amount));
  const muted = (r: TaxLineRow) => r.amount === null || r.amount === '0.00';
  const emphasised = (r: TaxLineRow) =>
    r.role === 'totalIncome' || r.role === 'totalDeductions' || r.role === 'netIncome';

  const csvRows = $derived<CsvCell[][]>([
    [`${report.form} worksheet`, `${report.year}`, `${report.basis} basis`],
    ['Period', report.from, report.to],
    [],
    ['Section', 'Line', 'Description', 'Amount'],
    ...report.income.map((r) => ['Income', r.line, r.label, r.amount ?? ''] as CsvCell[]),
    ...report.deductions.map(
      (r) =>
        [
          'Deductions',
          r.line,
          r.userSupplied ? `${r.label} (you must supply)` : r.label,
          r.amount ?? '',
        ] as CsvCell[],
    ),
    ...report.unmappedExpenses.map(
      (a) => ['Deductions', '', `UNMAPPED — ${a.code} ${a.name}`, a.amount] as CsvCell[],
    ),
    // The itemised statement travels with the export — it's the part a preparer
    // actually files, and a CSV that stopped at the line total would be useless.
    ...(itemised && itemised.accounts.length > 0
      ? ([
          [],
          [`Line ${itemised.line} — ${itemised.label}`],
          ['', 'Account', 'Description', 'Amount'],
          ...itemised.accounts.map((a) => ['', a.code, a.name, a.amount] as CsvCell[]),
          ['', '', 'Total', itemised.amount ?? '0.00'],
        ] as CsvCell[][])
      : []),
  ]);
</script>

<!-- Toolbar — hidden when printing. -->
<div class="flex flex-wrap items-baseline justify-between gap-6 print:hidden">
  <div>
    <a href="/reports" class="eyebrow text-fg/60 hover:text-fg">← Reports</a>
    <h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-fg">
      {report.form}<span class="text-accent">.</span>
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
    <ExportCsvButton
      filename="tax-worksheet_{report.formCode}_{report.year}_{report.basis}"
      rows={csvRows}
    />
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

<article
  class="mt-6 rounded-sm border border-fg/10 bg-surface-2 p-8 print:border-0 print:bg-white print:p-0"
>
  <header class="border-b border-fg/10 pb-5">
    <h2 class="font-serif text-2xl font-light text-fg">
      {report.form} worksheet — {report.year}
    </h2>
    <p class="mt-1 text-sm text-fg/60">
      {report.from} → {report.to} · {basisLabel}
    </p>
  </header>

  <!-- Income. The lines we have no data model for (returns, cost of goods sold,
       the various gain/loss lines) render at zero so the form reads whole rather
       than abridged. -->
  <section class="mt-6">
    <h3 class="label">{incomeHeading}</h3>
    <table class="mt-3 w-full text-left text-sm">
      <tbody class="divide-y divide-fg/10">
        {#each report.income as r (r.line)}
          <tr class={emphasised(r) ? 'font-medium' : ''}>
            <td class="w-12 py-2 pr-4 font-mono text-xs text-fg/40">{r.line}</td>
            <td class="py-2 {muted(r) ? 'text-fg/50' : 'text-fg/80'}">{r.label}</td>
            <td
              class="w-36 py-2 text-right font-mono tabular-nums {muted(r)
                ? 'text-fg/50'
                : 'text-fg'}"
            >
              {amountOf(r)}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </section>

  <!-- Deductions. Every line renders, including the ones we never post to, so
       the output can be read alongside the real form. -->
  <section class="mt-8">
    <h3 class="label">{deductionsHeading}</h3>
    <table class="mt-3 w-full text-left text-sm">
      <tbody class="divide-y divide-fg/10">
        {#each report.deductions as r (r.line)}
          <tr class={emphasised(r) ? 'font-medium' : ''}>
            <td class="w-12 py-2 pr-4 align-top font-mono text-xs text-fg/40">{r.line}</td>
            <td class="py-2 {r.subLine ? 'pl-6' : ''}">
              <span class={muted(r) ? 'text-fg/50' : 'text-fg/80'}>{r.label}</span>
              {#if r.userSupplied}
                <span class="ml-2 text-xs text-accent">you must supply this</span>
              {/if}
              <!-- Show the working when more than one account feeds a line, so
                   an unexpected figure is traceable without leaving the page.
                   The catch-all is exempt — it gets its own section. -->
              {#if r.itemized && r.accounts.length > 0}
                <span class="mt-0.5 block text-xs text-fg/40">
                  Itemised below — {r.accounts.length}
                  {r.accounts.length === 1 ? 'account' : 'accounts'}
                </span>
              {:else if !r.itemized && r.accounts.length > 1}
                <span class="mt-0.5 block text-xs text-fg/40">
                  {r.accounts.map((a) => `${a.name} ${fmt(a.amount)}`).join(' · ')}
                </span>
              {/if}
            </td>
            <td
              class="w-36 py-2 text-right align-top font-mono tabular-nums {muted(r)
                ? 'text-fg/40'
                : 'text-fg'}"
            >
              {amountOf(r)}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </section>

  <!-- The itemised statement. On the 1065 / 1120-S / 1120 more than half the
       chart lands on this one line, and the return is filed with a statement
       breaking it down account by account — so it renders expanded, as the thing
       a preparer actually needs, rather than tucked behind a disclosure. -->
  {#if itemised && itemised.accounts.length > 0}
    <section class="mt-8">
      <h3 class="label">Line {itemised.line} — {itemised.label}</h3>
      <p class="mt-2 text-sm text-fg/70">
        File this breakdown with the return. {report.form} has no dedicated line for these, so they
        combine into line {itemised.line}.
      </p>
      <table class="mt-3 w-full text-left text-sm">
        <tbody class="divide-y divide-fg/10">
          {#each itemised.accounts as a (a.code)}
            <tr>
              <td class="w-16 py-2 pr-4 font-mono text-xs text-fg/40">{a.code}</td>
              <td class="py-2 text-fg/80">{a.name}</td>
              <td class="w-36 py-2 text-right font-mono tabular-nums text-fg">{fmt(a.amount)}</td>
            </tr>
          {/each}
        </tbody>
        <tfoot class="border-t-2 border-fg/20">
          <tr class="font-medium">
            <td class="py-3 pr-4"></td>
            <td class="py-3 text-fg">Total — line {itemised.line}</td>
            <td class="py-3 text-right font-mono tabular-nums text-fg">
              {fmt(itemised.amount ?? '0.00')}
            </td>
          </tr>
        </tfoot>
      </table>
    </section>
  {/if}

  <!-- An account we can't place still counts toward total deductions, so it has
       to be visible — otherwise the total quietly disagrees with the P&L. -->
  {#if hasUnmapped}
    <section class="mt-8">
      <h3 class="label text-danger">Not mapped to a {report.form} line</h3>
      <p class="mt-2 text-sm text-fg/70">
        These are included in total deductions but we don't know which line they belong on. Review
        them with whoever prepares your return.
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
      Anything marked <span class="text-accent">you must supply this</span> is blank because
      Thalermark doesn't track it — fill those in yourself, and note that the totals below them
      don't subtract what you add. Cost of goods sold shows zero because there's no inventory here;
      materials you bill on are recorded as supplies, and are already counted there.
      {#if isScheduleC}
        Schedule C part III is not included.
      {:else}
        Schedules K, K-1, L, M-1 and M-2 are not included.
      {/if}
    </p>
  </footer>
</article>

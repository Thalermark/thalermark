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
  let { data, form }: PageProps = $props();

  const { report, years } = $derived(data);

  const fmt = (s: string) =>
    Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  // Query-string links rather than a form — keeps the page bookmarkable and
  // shareable at an exact year/basis, and needs no client state.
  const hrefFor = (opts: { year?: number; basis?: string; method?: string }) => {
    const p = new URLSearchParams({
      year: String(opts.year ?? report.year),
      basis: opts.basis ?? report.basis,
      method: opts.method ?? report.mileage.method,
    });
    return `?${p.toString()}`;
  };

  // True when the view was overridden away from the company's saved election —
  // the page has to say so, or Settings and this page silently disagree.
  const overridden = $derived(report.basis !== report.companyAccountingMethod);
  const methodOverridden = $derived(report.mileage.method !== report.mileage.companyMethod);
  const mileage = $derived(report.mileage);
  // On the three corporate/partnership forms mileage never reaches a line — the
  // business reimburses the driver instead, and that reimbursement posts as
  // ordinary spend. The copy has to say so, or the figure reads as a deduction
  // that silently went missing.
  const hasNonScheduleCMileage = $derived(report.formCode !== 'schedule_c');
  const vehicleInfo = $derived(report.vehicleInfo);
  const milesFmt = (s: string) =>
    Number(s).toLocaleString('en-US', { maximumFractionDigits: 1 });
  // An unanswered yes/no prints as an em dash, never as "No" — a guessed answer
  // on a signed return is worse than a visible gap.
  const yesNo = (v: boolean | null) => (v === null ? '—' : v ? 'Yes' : 'No');

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
    ...report.deductions.flatMap((r) => {
      const own: CsvCell[] = [
        'Deductions',
        r.line,
        r.userSupplied ? `${r.label} (you must supply)` : r.label,
        r.amount ?? '',
      ];
      // The working travels with the export: a line total that silently
      // included a non-ledger figure would be unreconcilable against the books.
      if (!r.computed) return [own];
      const fromBooks = r.accounts.reduce((s, a) => s + Number(a.amount), 0);
      return [
        own,
        ...(r.accounts.length > 0
          ? ([['Deductions', '', '    from the books', fromBooks.toFixed(2)]] as CsvCell[][])
          : []),
        ...r.computed.map((c) => ['Deductions', '', `    ${c.label}`, c.amount] as CsvCell[]),
      ];
    }),
    ...report.unmappedExpenses.map(
      (a) => ['Deductions', '', `UNMAPPED — ${a.code} ${a.name}`, a.amount] as CsvCell[],
    ),
    // Part IV travels with the export too, and this matters more than the
    // on-screen version: the preparer works off the CSV, and the disclosure is
    // the half they cannot reconstruct from the numbers.
    ...(vehicleInfo.destination !== 'none' && vehicleInfo.rows.length > 0
      ? ([
          [],
          [
            vehicleInfo.destination === 'schedule_c_part_iv'
              ? 'Part IV — Information on your vehicle'
              : 'Vehicle information (likely Form 4562 Part V)',
          ],
          ['Vehicle', 'Line', 'Question', 'Answer'],
          ...vehicleInfo.rows.flatMap((v) => [
            [v.label, '43', 'Placed in service', v.placedInServiceOn ?? ''],
            [v.label, '44a', 'Business miles', v.businessMiles],
            [v.label, '44b', 'Commuting miles', v.commutingMiles],
            [v.label, '44c', 'Other (personal) miles', v.otherMiles ?? ''],
            [v.label, '45', 'Available for personal use', yesNo(v.personalUseAvailable)],
            [v.label, '46', 'Another vehicle available', yesNo(v.anotherVehicleAvailable)],
            [v.label, '47a', 'Evidence to support the deduction', 'Yes'],
            [v.label, '47b', 'Evidence is written', 'Yes'],
          ]),
          ...(Number(vehicleInfo.unassignedMiles) > 0
            ? ([
                [
                  'UNASSIGNED',
                  '',
                  'Miles on trips naming no vehicle — in the deduction, not in the rows above',
                  vehicleInfo.unassignedMiles,
                ],
              ] as CsvCell[][])
            : []),
        ] as CsvCell[][])
      : []),
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
  <!--
    Vehicle election, overridable per view exactly like basis — so the two
    figures can be compared without flipping the saved setting (TMC-179). Only
    offered when there are trips; on a company that has never logged one it is
    a control over nothing.
  -->
  {#if mileage.tripCount > 0}
    <div class="flex items-center gap-2">
      <span class="label">Vehicle</span>
      {#each [['standard', 'Per mile'], ['actual', 'Actual costs']] as [value, label] (value)}
        <a
          href={hrefFor({ method: value })}
          class="rounded-sm border px-3 py-1 text-sm transition-colors {value === mileage.method
            ? 'border-accent bg-accent/10 text-accent'
            : 'border-fg/15 text-fg/70 hover:border-accent/40 hover:text-accent'}"
        >
          {label}
        </a>
      {/each}
    </div>
  {/if}
</div>

{#if methodOverridden && mileage.tripCount > 0}
  <p class="mt-4 callout print:hidden">
    You're viewing this as if you deducted
    <strong>{mileage.method === 'standard' ? 'a flat rate per mile' : 'actual vehicle costs'}</strong
    >, but this business is set to
    <strong
      >{mileage.companyMethod === 'standard' ? 'a flat rate per mile' : 'actual vehicle costs'}</strong
    >. Change the saved setting in
    <a href="/settings/business" class="link">Settings → Business</a> if that's wrong.
  </p>
{/if}

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
              <!-- Non-ledger half of the line (standard mileage). Shown even
                   when it's the only contributor, because a figure with no
                   account behind it is exactly the one a reader will query. -->
              {#if r.computed}
                <span class="mt-0.5 block text-xs text-fg/40">
                  {#if r.accounts.length > 0}
                    From the books {fmt(
                      r.accounts.reduce((s, a) => s + Number(a.amount), 0).toFixed(2),
                    )} ·
                  {/if}
                  {r.computed.map((c) => `${c.label} ${fmt(c.amount)}`).join(' · ')}
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

  <!--
    Standard mileage (TMC-179). Rendered for EVERY form, because the number
    matters even where it doesn't land on a line: a corporation reimburses the
    driver under an accountable plan rather than deducting mileage on its own
    return, and the driver still needs to be told what they're owed.
  -->
  {#if mileage.tripCount > 0}
    <section class="mt-8">
      <h3 class="label">Business driving</h3>
      <div class="mt-3 flex flex-wrap items-baseline justify-between gap-4 text-sm">
        <span class="text-fg/80">
          {Number(mileage.miles).toLocaleString('en-US', { maximumFractionDigits: 1 })} miles over
          {mileage.tripCount}
          {mileage.tripCount === 1 ? 'trip' : 'trips'}
        </span>
        <span class="font-mono tabular-nums text-fg">
          {fmt(mileage.method === 'standard' ? mileage.amount : mileage.foregone)}
        </span>
      </div>

      {#if mileage.method === 'actual'}
        <p class="mt-2 text-sm text-fg/70">
          That's what a flat rate per mile would have been worth. It isn't on the worksheet because
          this business deducts its actual vehicle costs instead — those are your real gas, repairs
          and insurance, scaled to business use, and only you can work out that share.
        </p>
      {:else if hasNonScheduleCMileage}
        <!-- The entity split. A shareholder-employee cannot deduct unreimbursed
             mileage personally, so the accountable-plan reimbursement is the
             mechanism — and that reimbursement is ordinary spend that already
             posts to 6100 on its own. -->
        <p class="mt-2 text-sm text-fg/70">
          This doesn't go on the business's return as a deduction — the business should
          <strong>reimburse you</strong> for it. Record that payment as an ordinary vehicle expense and
          it lands on the return the usual way. Ask whoever prepares your return about an accountable
          plan if you haven't set one up.
        </p>
      {/if}

      {#if Number(mileage.unratedMiles) > 0}
        <p class="mt-2 text-sm text-fg/70">
          {Number(mileage.unratedMiles).toLocaleString('en-US', { maximumFractionDigits: 1 })} of
          those miles are on dates the IRS hasn't published a rate for, so they aren't in the figure
          above.
        </p>
      {/if}

      <!-- The double-dip warning. Named, never netted: we cannot know which part
           of Repairs was the truck. Warned, never blocked: parking and tolls ARE
           deductible on top of the standard rate. -->
      {#if mileage.overlapping.length > 0}
        <div class="callout mt-4">
          <p>
            The rate per mile already covers your fuel, repairs, insurance and the vehicle's
            depreciation. You've also recorded these separately this year, so some of it may be
            counted twice — worth checking with whoever prepares your return.
          </p>
          <ul class="mt-2 space-y-1">
            {#each mileage.overlapping as a (a.code)}
              <li class="flex justify-between gap-4">
                <span>{a.name}</span>
                <span class="font-mono tabular-nums">{fmt(a.amount)}</span>
              </li>
            {/each}
          </ul>
          <p class="mt-2">
            Parking and tolls are fine to claim on top — it's the fuel and running costs that
            overlap.
          </p>
        </div>
      {/if}
    </section>
  {/if}

  <!--
    Schedule C Part IV, "Information on Your Vehicle" (TMC-179). Answered HERE
    rather than only in Settings, because this is the only tax-time surface with
    no capability gate — and because the question belongs next to the empty box
    it fills. Inputs are print:hidden; answered values print, since the printed
    sheet is what goes to the preparer.
  -->
  {#if vehicleInfo.destination !== 'none' && vehicleInfo.rows.length > 0}
    <section class="mt-8">
      <h3 class="label">
        {vehicleInfo.destination === 'schedule_c_part_iv'
          ? 'Part IV — Information on your vehicle'
          : 'Your vehicle'}
      </h3>
      {#if vehicleInfo.destination === 'form_4562_part_v'}
        <p class="mt-2 text-sm text-fg/70">
          Because you're claiming depreciation this year, these details likely go on Form 4562
          rather than Schedule C Part IV. Same answers, different box — whoever prepares your
          return will know which.
        </p>
      {/if}

      {#each vehicleInfo.rows as v (v.vehicleId)}
        <div class="mt-4 rounded-sm border border-fg/10 bg-surface p-5 print:border-0 print:p-0">
          <p class="font-serif text-lg text-fg">{v.label}</p>

          <dl class="mt-3 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
            <div class="flex justify-between gap-4">
              <dt class="text-fg/60">First used for work (43)</dt>
              <dd class="text-fg">{v.placedInServiceOn ?? '—'}</dd>
            </div>
            <div class="flex justify-between gap-4">
              <dt class="text-fg/60">Business miles (44a)</dt>
              <dd class="font-mono tabular-nums text-fg">{milesFmt(v.businessMiles)}</dd>
            </div>
            <div class="flex justify-between gap-4">
              <dt class="text-fg/60">Commuting miles (44b)</dt>
              <dd class="font-mono tabular-nums text-fg">{milesFmt(v.commutingMiles)}</dd>
            </div>
            <div class="flex justify-between gap-4">
              <dt class="text-fg/60">Other, personal miles (44c)</dt>
              <dd class="font-mono tabular-nums text-fg">
                {v.otherMiles === null ? '—' : milesFmt(v.otherMiles)}
              </dd>
            </div>
            <div class="flex justify-between gap-4">
              <dt class="text-fg/60">Available for personal use? (45)</dt>
              <dd class="text-fg">{yesNo(v.personalUseAvailable)}</dd>
            </div>
            <div class="flex justify-between gap-4">
              <dt class="text-fg/60">Another vehicle for personal use? (46)</dt>
              <dd class="text-fg">{yesNo(v.anotherVehicleAvailable)}</dd>
            </div>
            <!--
              47a and 47b are free — they logged the trips here, so the evidence
              exists and it is written. Worth saying rather than burying.
            -->
            <div class="flex justify-between gap-4">
              <dt class="text-fg/60">Evidence, and is it written? (47a/b)</dt>
              <dd class="text-fg">Yes — your trip log</dd>
            </div>
          </dl>

          {#if v.inconsistent}
            <p class="callout mt-4">
              The total you gave no longer covers the {milesFmt(v.businessMiles)} business miles logged
              against this vehicle — you've probably added trips since. Update the total below.
            </p>
          {/if}

          {#if v.missing.length > 0 || v.inconsistent}
            <div class="mt-4 print:hidden">
              {#if v.missing.some((m) => m !== 'total_miles')}
                <form method="POST" action="?/saveVehicleFacts" class="grid gap-3 sm:grid-cols-3">
                  <input type="hidden" name="vehicleId" value={v.vehicleId} />
                  <label class="block">
                    <span class="label">First used for work</span>
                    <input
                      type="date"
                      name="placedInServiceOn"
                      value={v.placedInServiceOn ?? ''}
                      class="field mt-1 w-full"
                    />
                  </label>
                  <label class="block">
                    <span class="label">Also driven personally?</span>
                    <select name="personalUse" class="field mt-1 w-full">
                      <option value="" selected={v.personalUseAvailable === null}>—</option>
                      <option value="none" selected={v.personalUseAvailable === false}>
                        No, work only
                      </option>
                      <option value="some" selected={v.personalUseAvailable === true}>
                        Yes, sometimes
                      </option>
                    </select>
                  </label>
                  <label class="block">
                    <span class="label">Another car for personal use?</span>
                    <select name="anotherVehicleAvailable" class="field mt-1 w-full">
                      <option value="" selected={v.anotherVehicleAvailable === null}>—</option>
                      <option value="yes" selected={v.anotherVehicleAvailable === true}>Yes</option>
                      <option value="no" selected={v.anotherVehicleAvailable === false}>No</option>
                    </select>
                  </label>
                  <div class="sm:col-span-3">
                    <button type="submit" class="btn">Save</button>
                  </div>
                </form>
              {/if}

              <!--
                The year figure, asked as a TOTAL and shown back as the personal
                remainder. People know their annual mileage from an oil change or
                an insurance quote; "personal miles" is a residual nobody tracks.
              -->
              {#if v.missing.includes('total_miles') || v.inconsistent}
                <form method="POST" action="?/saveVehicleYear" class="mt-4 flex flex-wrap items-end gap-3">
                  <input type="hidden" name="vehicleId" value={v.vehicleId} />
                  <input type="hidden" name="year" value={report.year} />
                  <label class="block">
                    <span class="label">Total miles in {report.year}, for everything</span>
                    <input
                      type="text"
                      inputmode="decimal"
                      name="totalMiles"
                      placeholder="12000"
                      value={v.totalMiles ?? ''}
                      class="field mt-1 w-40"
                    />
                  </label>
                  <label class="block">
                    <span class="label">Of which commuting</span>
                    <input
                      type="text"
                      inputmode="decimal"
                      name="commutingMiles"
                      value={v.commutingMiles}
                      class="field mt-1 w-32"
                    />
                  </label>
                  <button type="submit" class="btn">Save</button>
                  <p class="w-full text-xs text-fg/50">
                    We already know your {milesFmt(v.businessMiles)} business miles from your trip log
                    — the rest is what you drove personally.
                  </p>
                </form>
              {/if}
            </div>
          {/if}
        </div>
      {/each}

      {#if Number(vehicleInfo.unassignedMiles) > 0}
        <!--
          The one new way to file a WRONG return: these miles fed line 9 but
          belong to no vehicle above, so the rows understate what was claimed.
        -->
        <div class="callout mt-4">
          <p>
            {milesFmt(vehicleInfo.unassignedMiles)} miles this year are on trips that don't say which
            vehicle you drove, so they aren't counted in any vehicle above — even though they are in
            your deduction. Assign them on the
            <a href="/mileage" class="link">Mileage page</a> so the two agree.
          </p>
        </div>
      {/if}

      {#if form?.vehicleError}
        <p class="mt-3 text-sm text-danger print:hidden">{form.vehicleError}</p>
      {:else if form?.vehicleYearSaved || form?.vehicleFactsSaved}
        <p class="mt-3 text-sm text-fg/60 print:hidden">Saved.</p>
      {/if}
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

<script lang="ts">
  import { enhance } from '$app/forms';
  import {
    type UnmatchedRow,
    parseTrialBalance,
  } from '$lib/trial-balance-import';
  import Papa from 'papaparse';
  import { untrack } from 'svelte';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const current = $derived(data.current);
  const fieldErrors = $derived(form?.fieldErrors ?? {});

  function err(key: string): string | undefined {
    return (fieldErrors as Record<string, string>)[key];
  }
  // Seed each field from a failed submit, else the saved balance, else blank.
  function v(key: 'asOfDate' | 'cash' | 'receivables' | 'payables'): string {
    const submitted = (form?.values as Record<string, unknown> | undefined)?.[key];
    if (typeof submitted === 'string') return submitted;
    const saved = current as Record<string, unknown> | null;
    const val = saved?.[key];
    return typeof val === 'string' ? val : '';
  }
  const dateValue = $derived(v('asOfDate') || current?.asOfDate || data.today);

  // The full opening trial balance — for a business arriving with real books.
  // Only offered to roles that can post adjustments, and only when the chart came
  // back with the load. The three plain questions stay the default: they're the
  // right first ask, and most people starting out have nothing else to say.
  const canEnterFull = $derived(data.accounts.length > 0);

  type Line = { coaAccountId: string; side: 'debit' | 'credit'; amount: string };

  // Seeded once, then owned by the form. `untrack` says that deliberately: these
  // are the starting values of an editable draft, not a view of `data` — without
  // it Svelte warns that only the initial value is captured, which is exactly
  // what's wanted here (same pattern as the ledger list's row state).
  let advanced = $state(untrack(() => data.current?.shape === 'full'));
  let lines = $state<Line[]>(
    untrack(() => {
      const saved = data.lines.map((l) => ({
        coaAccountId: l.coaAccountId,
        side: l.side as 'debit' | 'credit',
        amount: l.amount,
      }));
      return saved.length > 0
        ? saved
        : [
            { coaAccountId: '', side: 'debit', amount: '' },
            { coaAccountId: '', side: 'credit', amount: '' },
          ];
    }),
  );

  // Live balance, in integer cents so the check is exact — the same discipline
  // the API applies with sumMoney. Submit stays disabled until it's zero, so a
  // user never round-trips just to be told the entry doesn't balance.
  const cents = (s: string) => Math.round(Number(s || '0') * 100);
  const debitCents = $derived(
    lines.filter((l) => l.side === 'debit').reduce((sum, l) => sum + cents(l.amount), 0),
  );
  const creditCents = $derived(
    lines.filter((l) => l.side === 'credit').reduce((sum, l) => sum + cents(l.amount), 0),
  );
  const balanced = $derived(debitCents === creditCents && debitCents > 0);
  const complete = $derived(
    lines.every((l) => l.coaAccountId !== '' && cents(l.amount) > 0) && lines.length >= 2,
  );
  const money = (c: number) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  function addLine() {
    lines = [...lines, { coaAccountId: '', side: 'debit', amount: '' }];
  }
  function removeLine(i: number) {
    lines = lines.filter((_, idx) => idx !== i);
  }

  // --- Import a trial balance (TMC-169) ------------------------------------
  // Fills the editor above rather than saving. The user sees what matched,
  // fixes what didn't, and the balance check still has to pass — an import
  // that wrote straight to the ledger would be a way to get someone else's
  // rounding errors into your books without looking at them.
  let importUnmatched = $state<UnmatchedRow[]>([]);
  let importError = $state<string | null>(null);
  let importedCount = $state(0);

  async function onTrialBalanceFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    importError = null;
    importUnmatched = [];
    importedCount = 0;

    const parsed = Papa.parse<string[]>(await file.text(), { skipEmptyLines: 'greedy' });
    const rows = parsed.data.map((r) => r.map((c) => String(c ?? '')));
    const result = parseTrialBalance(rows, data.accounts);

    if (result.error === 'no_columns') {
      importError =
        "We couldn't find the columns in that file. It needs a heading row with an account column and either Debit and Credit columns, or a single amount column.";
      return;
    }
    if (result.error === 'no_rows') {
      importError = "That file has headings but no rows we could read.";
      return;
    }

    lines = result.lines.map((l) => ({
      coaAccountId: l.coaAccountId,
      side: l.side,
      amount: l.amount,
    }));
    importUnmatched = result.unmatched;
    importedCount = result.lines.length;
    // Something has to be selectable for the unmatched amounts to go onto.
    if (result.unmatched.length > 0) {
      lines = [...lines, { coaAccountId: '', side: 'debit', amount: '' }];
    }
  }
</script>

<a href="/owner-money" class="eyebrow text-fg/60 hover:text-fg">← Investments</a>
<h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-fg">
  Starting balances<span class="text-accent">.</span>
</h1>
<p class="mt-4 max-w-2xl text-sm text-fg/60">
  What your business already had when you started using Thalermark — so your numbers are right from
  day one. Fill in what applies; leave the rest blank.
</p>

{#if form?.formError}
  <div class="mt-6 rounded-sm border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
    {form.formError}
  </div>
{/if}

{#if !advanced}
  <form method="post" action="?/save" class="mt-8 space-y-6" use:enhance>
  <div>
    <label for="asOfDate" class="label">When did you start?<span class="text-accent">*</span></label>
    <input id="asOfDate" name="asOfDate" type="date" required value={dateValue} class="field mt-1" />
    {#if err('asOfDate')}
      <p class="mt-1 text-xs text-danger">{err('asOfDate')}</p>
    {/if}
  </div>

  <div>
    <label for="cash" class="label">Money in the bank</label>
    <p class="text-xs text-fg/50">How much was in the business account when you started.</p>
    <input
      id="cash"
      name="cash"
      type="text"
      inputmode="decimal"
      placeholder="0.00"
      value={v('cash')}
      class="mt-1 w-full rounded-sm border border-fg/15 bg-surface-2 px-3 py-2 font-mono tabular-nums text-fg focus:border-accent focus:outline-none"
    />
    {#if err('cash')}
      <p class="mt-1 text-xs text-danger">{err('cash')}</p>
    {/if}
  </div>

  <div>
    <label for="receivables" class="label">Money customers already owed you</label>
    <p class="text-xs text-fg/50">Unpaid work from before you started here.</p>
    <input
      id="receivables"
      name="receivables"
      type="text"
      inputmode="decimal"
      placeholder="0.00"
      value={v('receivables')}
      class="mt-1 w-full rounded-sm border border-fg/15 bg-surface-2 px-3 py-2 font-mono tabular-nums text-fg focus:border-accent focus:outline-none"
    />
  </div>

  <div>
    <label for="payables" class="label">Money you already owed</label>
    <p class="text-xs text-fg/50">Bills or suppliers you hadn't paid yet.</p>
    <input
      id="payables"
      name="payables"
      type="text"
      inputmode="decimal"
      placeholder="0.00"
      value={v('payables')}
      class="mt-1 w-full rounded-sm border border-fg/15 bg-surface-2 px-3 py-2 font-mono tabular-nums text-fg focus:border-accent focus:outline-none"
    />
  </div>

    <div class="flex items-center gap-4">
      <button type="submit" class="btn">Save</button>
      <a href="/owner-money" class="text-sm text-fg/60 hover:text-fg">Cancel</a>
    </div>
  </form>
{/if}

{#if canEnterFull}
  <div class="mt-8 border-t border-fg/10 pt-6">
    <button
      type="button"
      class="link text-sm"
      onclick={() => (advanced = !advanced)}
    >
      {advanced ? '← Just the three questions' : 'Coming from other accounting software?'}
    </button>
    {#if !advanced}
      <p class="mt-2 max-w-2xl text-sm text-fg/50">
        If you've been trading a while, you probably have more than three figures — equipment
        you've already written down, a loan, tax you've collected. Enter your full opening
        balances instead.
      </p>
    {/if}
  </div>
{/if}

{#if advanced}
  <form method="post" action="?/saveFull" class="mt-6" use:enhance>
    <input type="hidden" name="asOfDate" value={dateValue} />
    <input type="hidden" name="lines" value={JSON.stringify(lines)} />

    <p class="max-w-2xl text-sm text-fg/60">
      Your closing balances from the software you're leaving, account by account. Your accountant
      will call this a trial balance — the debits and credits have to come out equal.
    </p>

    <!-- The mid-year ask. Someone who started trading in January and switched
         in July still files ONE return for the whole year, and Thalermark only
         knows about the part after they arrived. Nothing else in the product
         tells them this, and the tax worksheet can't tell on its own — so it
         gets said here, where they're already entering the past. -->
    <div class="callout mt-5 max-w-2xl">
      <p class="text-sm text-fg/70">
        <span class="text-fg">Already been trading this year?</span>
        Include what you've earned and spent since 1 January, not just what you own and owe. You
        file one tax return for the whole year, so anything you leave out here is missing from
        your tax worksheet later.
      </p>
    </div>

    <!-- Import. Fills the editor below; nothing is saved until the user
         submits, so what came out of their old software is reviewable first. -->
    <div class="mt-5 max-w-2xl rounded-sm border border-fg/10 bg-surface-2 p-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p class="text-sm text-fg">Import a trial balance</p>
          <p class="mt-0.5 text-xs text-fg/50">
            Export "Trial Balance" as CSV from QuickBooks, Xero or Wave. We'll match it to your
            accounts — you check it before saving.
          </p>
        </div>
        <label
          class="inline-flex shrink-0 cursor-pointer items-center gap-2 rounded-sm border border-fg/15 bg-surface px-4 py-2 text-sm font-medium text-fg transition-colors hover:border-accent/40 hover:text-accent"
        >
          Choose file
          <input type="file" accept=".csv,text/csv" class="hidden" onchange={onTrialBalanceFile} />
        </label>
      </div>

      {#if importError}
        <p class="mt-3 text-sm text-danger">{importError}</p>
      {/if}

      {#if importedCount > 0}
        <p class="mt-3 text-sm text-fg/70">
          Matched <strong class="text-fg">{importedCount}</strong>
          {importedCount === 1 ? 'account' : 'accounts'}. Check them below before saving.
        </p>
      {/if}

      <!-- Never silently dropped: an unmatched row is money the file had and
           the editor doesn't, which is exactly why it wouldn't balance. -->
      {#if importUnmatched.length > 0}
        <div class="mt-3 rounded-sm border border-danger/30 bg-danger/5 px-3 py-2">
          <p class="text-sm text-danger">
            {importUnmatched.length}
            {importUnmatched.length === 1 ? 'row' : 'rows'} didn't match an account of yours. Add
            {importUnmatched.length === 1 ? 'it' : 'them'} below by hand, or the totals won't balance.
          </p>
          <ul class="mt-2 space-y-1 text-xs text-fg/70">
            {#each importUnmatched as u (u.label)}
              <li class="flex justify-between gap-4">
                <span>{u.label}</span>
                <span class="font-mono tabular-nums">{u.side} {u.amount}</span>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    </div>

    {#if form?.fullError}
      <div class="mt-4 rounded-sm border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
        {form.fullError}
      </div>
    {/if}

    <div class="mt-5 space-y-3">
      {#each lines as line, i (i)}
        <div class="flex flex-wrap items-center gap-3">
          <select
            bind:value={line.coaAccountId}
            class="min-w-[18rem] flex-1 rounded-sm border border-fg/15 bg-surface-2 px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
          >
            <option value="">Pick an account…</option>
            {#each data.accounts as a (a.id)}
              <option value={a.id}>{a.code} · {a.name}</option>
            {/each}
          </select>
          <select
            bind:value={line.side}
            class="rounded-sm border border-fg/15 bg-surface-2 px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
          >
            <option value="debit">Debit</option>
            <option value="credit">Credit</option>
          </select>
          <input
            type="text"
            inputmode="decimal"
            placeholder="0.00"
            bind:value={line.amount}
            class="w-32 rounded-sm border border-fg/15 bg-surface-2 px-3 py-2 font-mono tabular-nums text-fg focus:border-accent focus:outline-none"
          />
          {#if lines.length > 2}
            <button
              type="button"
              class="text-sm text-fg/40 hover:text-danger"
              onclick={() => removeLine(i)}
              aria-label="Remove line"
            >
              ×
            </button>
          {/if}
        </div>
      {/each}
    </div>

    <button type="button" class="link mt-4 text-sm" onclick={addLine}>+ Add another account</button>

    <div class="mt-6 flex flex-wrap items-center gap-6 border-t border-fg/10 pt-4">
      <div class="font-mono text-sm tabular-nums">
        <span class="text-fg/50">Debits</span>
        <span class="ml-2 text-fg">{money(debitCents)}</span>
        <span class="ml-5 text-fg/50">Credits</span>
        <span class="ml-2 text-fg">{money(creditCents)}</span>
      </div>
      {#if !balanced && debitCents + creditCents > 0}
        <span class="text-sm text-danger">
          Out by {money(Math.abs(debitCents - creditCents))}
        </span>
      {:else if balanced}
        <span class="text-sm text-fg/50">Balanced</span>
      {/if}
    </div>

    <div class="mt-6 flex items-center gap-4">
      <button type="submit" class="btn" disabled={!balanced || !complete}>Save</button>
      <a href="/owner-money" class="text-sm text-fg/60 hover:text-fg">Cancel</a>
    </div>
  </form>
{/if}

{#if current}
  <form method="post" action="?/clear" class="mt-8 border-t border-fg/10 pt-6" use:enhance>
    <p class="text-sm text-fg/60">
      Clear your starting balances if you entered them by mistake. This removes them from your books.
    </p>
    <button
      type="submit"
      class="mt-3 rounded-sm border border-danger/30 px-3 py-1 font-mono text-xs uppercase tracking-widest text-danger/80 hover:border-danger hover:text-danger"
    >
      Clear starting balances
    </button>
  </form>
{/if}

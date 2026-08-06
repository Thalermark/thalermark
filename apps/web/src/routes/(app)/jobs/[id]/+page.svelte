<script lang="ts">
  import { may } from '$lib/perms';
  import { formatUnitPrice, hoursFromMinutes, multiplyMoney, sumMoney } from '@thalermark/validation';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const job = $derived(data.job);
  const margin = $derived(data.job.margin);
  const time = $derived(data.time);
  const canWrite = $derived(may(data.role, 'sales:write'));

  const fmt = (s: string) =>
    Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  const today = new Date().toISOString().slice(0, 10);

  // The most recent rate used on this job, to prefill the next entry. Entries
  // come back newest-first, so the first one carrying a rate is the last one
  // used. Empty when nothing has been rated yet.
  const lastRate = $derived(
    formatUnitPrice(time.timeEntries.find((e) => e.rate)?.rate ?? '') || '',
  );

  // DISPLAY only, 2dp. Never use this for money: billing converts with
  // hoursFromMinutes at 4dp, and 50 minutes is 0.83 here against 0.8333 there —
  // a nickel apart at $15/h. Anything that must agree with the invoice goes
  // through entryValue below.
  function hours(minutes: number): string {
    return (Math.round((minutes / 60) * 100) / 100).toFixed(2);
  }

  // What an entry will actually bill, priced exactly the way the invoice form
  // prices it — same 4dp quantity, same multiplyMoney.
  function entryValue(minutes: number, rate: string): string {
    return multiplyMoney(hoursFromMinutes(minutes), rate);
  }

  // Tracked hours not yet on an invoice — what "Bill this job" would add right
  // now. Only entries carrying a rate: unrated hours bill nothing, and folding
  // them in at zero would understate nothing but confuse everything.
  const readyToBill = $derived(
    sumMoney(
      time.timeEntries
        .filter((e) => !e.billedInvoiceId && e.rate)
        .map((e) => entryValue(e.minutes, e.rate as string)),
    ),
  );

  // Unbilled hours with no rate. Called out separately so "ready to bill" is
  // never mistaken for "all the work I haven't charged for".
  // An unsent draft already on this job. Billing again would start a SECOND
  // draft rather than continuing the one sitting there — each burning an invoice
  // number — so the button points at the existing one instead.
  const openDraft = $derived(job.invoices.find((i) => i.status === 'draft'));

  const unratedMinutes = $derived(
    time.timeEntries
      .filter((e) => !e.billedInvoiceId && !e.rate)
      .reduce((total, e) => total + e.minutes, 0),
  );
</script>

<a href="/jobs" class="eyebrow text-fg/60 hover:text-fg">← Jobs</a>
<div class="mt-3 flex flex-wrap items-baseline justify-between gap-4">
  <div>
    <h1 class="font-serif text-4xl font-light leading-none tracking-tight text-fg">
      {job.name}<span class="text-accent">.</span>
    </h1>
    <!--
      The customer is asked for at create, so it has to show back here — not
      showing it reads as "that field did nothing".
    -->
    {#if job.contactName}
      <p class="mt-2 text-sm text-fg/60">for {job.contactName}</p>
    {/if}
  </div>
  {#if canWrite}
    <div class="flex items-center gap-2">
      <!--
        The entry point for billing. You decide to bill a job while looking at
        the job, not while staring at an empty invoice — so this is what carries
        the job and its unbilled hours into the form.
      -->
      <!--
        Three states, one button position:
        - an unsent draft exists -> continue THAT, never start a second one
        - hours waiting          -> bill them
        - nothing waiting        -> DISABLED. Clicking through to a form with no
          job, no hours and no prefill produces an empty invoice and wastes the
          trip. A real <button disabled> rather than a dimmed link, so it is
          actually unclickable and announces itself as disabled; .btn already
          carries the disabled styling.

        The flat-fee path is not lost — /invoices/new still has a job picker for
        an invoice that isn't built from tracked hours.
      -->
      {#if openDraft}
        <a href="/invoices/{openDraft.id}/edit" class="btn">Continue {openDraft.number}</a>
      {:else if Number(readyToBill) > 0}
        <a href="/invoices/new?jobId={job.id}" class="btn">Bill this job</a>
      {:else}
        <button
          type="button"
          disabled
          class="btn"
          title={unratedMinutes > 0
            ? 'These hours need a rate before they can be billed'
            : 'Nothing to bill — log some hours first'}
        >
          Bill this job
        </button>
      {/if}
      <form method="post" action="?/setStatus">
        <input type="hidden" name="status" value={job.status === 'open' ? 'closed' : 'open'} />
        <button
          type="submit"
          class="rounded-sm border border-fg/15 px-3 py-1.5 font-mono text-xs uppercase tracking-widest text-fg/60 transition-colors hover:border-accent hover:text-accent"
        >
          {job.status === 'open' ? 'Close job' : 'Reopen'}
        </button>
      </form>
    </div>
  {/if}
</div>

{#if form?.actionError}
  <div class="mt-6 rounded-sm border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
    {form.actionError}
  </div>
{/if}

<!--
  The margin block. "Made" is billed minus what you bought for it; the hours are
  never subtracted into it, because a sole proprietor's own labour is not a
  deductible expense. They divide it instead — which is the number that answers
  "was this job worth my time".
-->
<div
  class="mt-8 grid gap-px overflow-hidden rounded-sm border border-fg/10 bg-fg/10 sm:grid-cols-2 lg:grid-cols-5"
>
  <!--
    Leads the bar: "what can I invoice right now" is the only number here you
    act on — the rest are history. Accent-coloured for the same reason, and only
    when there is actually something waiting.
  -->
  <div class="bg-surface-2 px-5 py-4">
    <span class="label">Ready to bill</span>
    <p
      class="mt-1 font-mono text-xl tabular-nums {Number(readyToBill) > 0
        ? 'text-accent'
        : 'text-fg/80'}"
    >
      {fmt(readyToBill)}
    </p>
    <!--
      The caveat lives WITH the number. Only rated hours can be billed, so a job
      with a day of unrated work would otherwise show $0.00 and read as "nothing
      to invoice" when there is plenty — just nothing priced yet.
    -->
    <p class="mt-1 text-xs text-fg/50">
      {#if unratedMinutes > 0}
        {hours(unratedMinutes)} h needs a rate
      {:else if Number(readyToBill) > 0}
        not on an invoice yet
      {:else}
        nothing waiting
      {/if}
    </p>
  </div>
  <div class="bg-surface-2 px-5 py-4">
    <span class="label">Billed</span>
    <p class="mt-1 font-mono text-xl tabular-nums text-fg/80">{fmt(margin.billed)}</p>
  </div>
  <div class="bg-surface-2 px-5 py-4">
    <span class="label">What it cost</span>
    <p class="mt-1 font-mono text-xl tabular-nums text-fg/80">{fmt(margin.costs)}</p>
  </div>
  <div class="bg-surface-2 px-5 py-4">
    <span class="label">Made</span>
    <p class="mt-1 font-mono text-xl tabular-nums text-fg">{fmt(margin.made)}</p>
  </div>
  <!--
    Per hour leads this tile, not the raw hour count: it is the number time
    tracking exists to produce — "was this job worth my time" — and the hours it
    was computed over ride underneath as its supporting detail.
  -->
  <div class="bg-surface-2 px-5 py-4">
    <span class="label">Per hour</span>
    <!--
      A dash, never $0.00. Zero would read as "this job paid you nothing an
      hour"; the truth until it is billed is "there is no answer yet".
    -->
    <p class="mt-1 font-mono text-xl tabular-nums text-fg">
      {margin.effectiveHourly ? fmt(margin.effectiveHourly) : '—'}
    </p>
    <p class="mt-1 text-xs text-fg/50">
      {margin.minutes > 0 ? `over ${margin.hours} h` : 'no hours logged'}
    </p>
  </div>
</div>

<h2 class="mt-10 font-serif text-2xl font-light text-fg">Invoices</h2>
{#if job.invoices.length === 0}
  <p class="mt-3 text-sm text-fg/60">
    Nothing billed yet. A job can carry as many invoices as it needs — a deposit and a final, or one
    every fortnight.
  </p>
{:else}
  <ul class="mt-4 divide-y divide-fg/10 rounded-sm border border-fg/10 bg-surface-2">
    {#each job.invoices as inv (inv.id)}
      <li>
        <a
          href="/invoices/{inv.id}"
          class="flex items-center justify-between gap-4 px-5 py-3 text-sm transition-colors hover:opacity-70"
        >
          <span class="font-mono text-xs text-fg/50">{inv.number}</span>
          <span class="text-fg/60">{inv.issueDate}</span>
          <span class="label">{inv.status}</span>
          <span class="font-mono tabular-nums text-fg/80">{fmt(inv.total)}</span>
        </a>
      </li>
    {/each}
  </ul>
{/if}

<h2 class="mt-10 font-serif text-2xl font-light text-fg">Hours</h2>

{#if canWrite}
  <!--
    A plain duration field, not only a timer. Reconstructing "3 hours yesterday"
    after the fact has to be as easy as running a stopwatch live, because the
    start of a job is the moment nobody is thinking about software.
  -->
  <!--
    One row, left to right: when, how long, how much, what, go. Rate used to sit
    on its own row BELOW the Log button, which put a field after the submit and
    read as an afterthought.
  -->
  <form
    method="post"
    action="?/logTime"
    class="mt-4 grid gap-3 sm:grid-cols-[9.5rem_6rem_8rem_1fr_auto]"
  >
    <div>
      <label for="entryDate" class="label block">Date</label>
      <input id="entryDate" name="entryDate" type="date" value={today} required class="field mt-1" />
    </div>
    <div>
      <label for="duration" class="label block">Hours</label>
      <input
        id="duration"
        name="duration"
        type="text"
        inputmode="decimal"
        placeholder="3.25"
        required
        class="field mt-1"
      />
    </div>
    <div>
      <label for="rate" class="label block">Rate</label>
      <!--
        Prefilled from the last rate used on this job. Most work is billed at one
        rate, so retyping it every entry is the kind of friction that stops
        people logging at all. Still editable, and still allowed to be empty.
      -->
      <input
        id="rate"
        name="rate"
        type="text"
        inputmode="decimal"
        placeholder="—"
        value={lastRate}
        class="field mt-1"
      />
    </div>
    <div>
      <label for="note" class="label block">What you did</label>
      <input id="note" name="note" type="text" maxlength="1000" class="field mt-1" />
    </div>
    <div class="flex items-end">
      <button type="submit" class="btn">Log</button>
    </div>
  </form>
  <p class="mt-2 text-xs text-fg/50">
    Leave the rate blank for hours you're not charging for — they still count toward what the job
    cost you in time.
  </p>
  {#if form?.timeError}
    <p class="mt-2 text-xs text-danger">{form.timeError}</p>
  {/if}
{/if}

{#if time.timeEntries.length === 0}
  <p class="mt-4 text-sm text-fg/60">No hours logged against this job yet.</p>
{:else}
  <ul class="mt-4 divide-y divide-fg/10 rounded-sm border border-fg/10 bg-surface-2">
    {#each time.timeEntries as entry (entry.id)}
      <li class="flex items-center justify-between gap-4 px-5 py-3 text-sm">
        <span class="w-28 shrink-0 text-fg/60">{entry.entryDate}</span>
        <span class="w-16 shrink-0 font-mono tabular-nums text-fg/80">{hours(entry.minutes)} h</span>
        <span class="min-w-0 flex-1 truncate text-fg/70">{entry.note ?? ''}</span>
        <!--
          What these hours are worth, and what they'll bill at. Silent when no
          rate was set — those hours count toward the job's time without being
          charged, and a "$0.00/h" there would look like a mistake.
        -->
        {#if entry.rate}
          <span class="shrink-0 text-right font-mono tabular-nums text-fg/60">
            ${formatUnitPrice(entry.rate)}/h
            <span class="ml-2 text-fg/80">
              {fmt(entryValue(entry.minutes, entry.rate))}
            </span>
          </span>
        {/if}
        {#if entry.billedInvoiceId}
          <span class="label text-fg/40">Billed</span>
        {:else if canWrite}
          <form method="post" action="?/deleteTime">
            <input type="hidden" name="id" value={entry.id} />
            <button type="submit" class="link text-xs">Remove</button>
          </form>
        {/if}
      </li>
    {/each}
  </ul>
  <p class="mt-3 text-sm text-fg/60">{time.totalHours} hours in total.</p>
{/if}

{#if canWrite && job.invoices.length === 0 && time.timeEntries.length === 0}
  <form method="post" action="?/delete" class="mt-10">
    <button type="submit" class="link text-xs text-danger">Delete this job</button>
    <p class="mt-1 text-xs text-fg/50">
      Only while it's empty. Once it has hours or invoices, close it instead.
    </p>
  </form>
{/if}

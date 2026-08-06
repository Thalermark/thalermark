<script lang="ts">
  import { may } from '$lib/perms';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const job = $derived(data.job);
  const margin = $derived(data.job.margin);
  const time = $derived(data.time);
  const canWrite = $derived(may(data.role, 'sales:write'));

  const fmt = (s: string) =>
    Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  const today = new Date().toISOString().slice(0, 10);

  function hours(minutes: number): string {
    return (Math.round((minutes / 60) * 100) / 100).toFixed(2);
  }
</script>

<a href="/jobs" class="eyebrow text-fg/60 hover:text-fg">← Jobs</a>
<div class="mt-3 flex flex-wrap items-baseline justify-between gap-4">
  <h1 class="font-serif text-4xl font-light leading-none tracking-tight text-fg">
    {job.name}<span class="text-accent">.</span>
  </h1>
  {#if canWrite}
    <form method="post" action="?/setStatus">
      <input type="hidden" name="status" value={job.status === 'open' ? 'closed' : 'open'} />
      <button
        type="submit"
        class="rounded-sm border border-fg/15 px-3 py-1.5 font-mono text-xs uppercase tracking-widest text-fg/60 transition-colors hover:border-accent hover:text-accent"
      >
        {job.status === 'open' ? 'Close job' : 'Reopen'}
      </button>
    </form>
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
<div class="mt-8 grid gap-px overflow-hidden rounded-sm border border-fg/10 bg-fg/10 sm:grid-cols-4">
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
  <div class="bg-surface-2 px-5 py-4">
    <span class="label">Per hour</span>
    <!--
      A dash, not $0.00, when nothing is logged. Zero would read as "this job
      paid you nothing an hour" rather than "you haven't told me the hours".
    -->
    <p class="mt-1 font-mono text-xl tabular-nums text-fg">
      {margin.effectiveHourly ? `${fmt(margin.effectiveHourly)}` : '—'}
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
  <form method="post" action="?/logTime" class="mt-4 grid gap-4 sm:grid-cols-[10rem_8rem_1fr_auto]">
    <div>
      <label for="entryDate" class="label">Date</label>
      <input id="entryDate" name="entryDate" type="date" value={today} required class="field mt-1" />
    </div>
    <div>
      <label for="duration" class="label">Hours</label>
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
      <label for="note" class="label">What you did</label>
      <input id="note" name="note" type="text" maxlength="1000" class="field mt-1" />
    </div>
    <div class="flex items-end">
      <button type="submit" class="btn">Log</button>
    </div>
    <div class="sm:col-span-4">
      <label for="rate" class="label">Rate per hour</label>
      <input
        id="rate"
        name="rate"
        type="text"
        inputmode="decimal"
        placeholder="Optional — leave blank if these hours aren't billable"
        class="field mt-1 max-w-sm"
      />
    </div>
  </form>
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

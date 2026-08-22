<script lang="ts">
  import ConfirmSubmit from '$lib/components/ConfirmSubmit.svelte';
  import { may } from '$lib/perms';
  import {
    BILLING_UNITS,
    billingUnitLabel,
    formatClockTime,
    formatQuantity,
    formatUnitPrice,
    minutesFromClockSpan,
    multiplyMoney,
    sumMoney,
    timeEntryQuantity,
  } from '@thalermark/validation';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const job = $derived(data.job);
  const margin = $derived(data.job.margin);
  const time = $derived(data.time);
  const canWrite = $derived(may(data.role, 'sales:write'));
  // Whatever was last driven to this job, else the only vehicle there is. A
  // one-truck operator never touches the picker.
  const defaultVehicleId = $derived(
    data.trips.find((t) => t.vehicleId)?.vehicleId ??
      (data.vehicles.length === 1 ? data.vehicles[0]?.id : '') ??
      '',
  );

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
  function hours(minutes: number | null): string {
    return (Math.round(((minutes ?? 0) / 60) * 100) / 100).toFixed(2);
  }

  // The job's own unit (TMC-264), and how one entry reads in it.
  const unit = $derived(time.billingUnit);
  const billsByHour = $derived(unit === 'hour');

  // What one entry contributes, in whatever the job bills in. Null when it
  // records nothing billable — an hourly entry with no duration, or a per-visit
  // entry with no count.
  function entryQty(entry: { minutes: number | null; quantity: string | null }): string | null {
    return timeEntryQuantity(entry, unit);
  }

  // How an entry reads in the list: "3.25 h" on an hourly job, "3 visits"
  // otherwise.
  function entryAmountLabel(entry: {
    minutes: number | null;
    quantity: string | null;
  }): string {
    if (billsByHour) return `${hours(entry.minutes)} h`;
    const qty = entry.quantity ?? '0';
    return `${formatQuantity(qty)} ${billingUnitLabel(unit, qty)}`;
  }

  // What an entry will actually bill, priced exactly the way the invoice form
  // prices it — same 4dp quantity, same multiplyMoney. Reads the job's unit for
  // the same reason: a "ready to bill" that disagrees with the invoice it
  // produces is worse than showing none.
  function entryValue(
    entry: { minutes: number | null; quantity: string | null },
    rate: string,
  ): string {
    const qty = entryQty(entry);
    return qty === null ? '0.00' : multiplyMoney(qty, rate);
  }

  // Tracked hours not yet on an invoice — what "Bill this job" would add right
  // now. Only entries carrying a rate: unrated hours bill nothing, and folding
  // them in at zero would understate nothing but confuse everything.
  const readyToBill = $derived(
    sumMoney(
      time.timeEntries
        .filter((e) => !e.billedInvoiceId && e.rate)
        .map((e) => entryValue(e, e.rate as string)),
    ),
  );

  // Unbilled hours with no rate. Called out separately so "ready to bill" is
  // never mistaken for "all the work I haven't charged for".
  // An unsent draft already on this job. Billing again would start a SECOND
  // draft rather than continuing the one sitting there — each burning an invoice
  // number — so the button points at the existing one instead.
  const openDraft = $derived(job.invoices.find((i) => i.status === 'draft'));

  // The caller's running stopwatch. `mine` means it is on THIS job; otherwise it
  // is being held by another one and starting here is refused.
  const timer = $derived(data.timer);
  const timerOnThisJob = $derived(timer?.jobId === job.id);

  // Ticks locally off started_at. Elapsed is never accumulated — a shut laptop
  // or a client clock that disagrees cannot drift it, because the server owns
  // the start instant and this only renders the difference.
  let now = $state(Date.now());
  $effect(() => {
    if (!timer) return;
    const t = setInterval(() => {
      now = Date.now();
    }, 1000);
    return () => clearInterval(t);
  });
  const elapsed = $derived.by(() => {
    if (!timer) return '';
    const secs = Math.max(0, Math.floor((now - new Date(timer.startedAt).getTime()) / 1000));
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
  });

  // A stop hands back minutes rather than logging — this drops them into the
  // duration field so the note and rate are still the user's to fill in.
  const stoppedDuration = $derived(
    form?.stoppedMinutes ? (Math.round((form.stoppedMinutes / 60) * 100) / 100).toFixed(2) : '',
  );

  // The time card (TMC-265). A third way in, beside the duration box and the
  // stopwatch, and the only one that is both after-the-fact AND arithmetic-free:
  // the duration field needs mental maths, and the stopwatch has to be
  // remembered at the START of the work, which is exactly when nobody is
  // thinking about an app.
  let cardStart = $state('');
  let cardEnd = $state('');
  const cardSpan = $derived(
    cardStart && cardEnd ? minutesFromClockSpan(cardStart, cardEnd) : null,
  );
  // Shown live so the user SEES the result before submitting. That sighting is
  // the "confirm" half of the owner's detect-and-confirm call: no modal, no
  // second question, just the hours stated plainly and the overnight run named.
  const cardSummary = $derived.by(() => {
    if (!cardStart || !cardEnd) return '';
    if (!cardSpan) return 'Check those times.';
    const h = Math.floor(cardSpan.minutes / 60);
    const m = cardSpan.minutes % 60;
    const span = m === 0 ? `${h}h` : `${h}h ${m}m`;
    return cardSpan.crossesMidnight
      ? `${span}, running past midnight. Logged on the start date.`
      : span;
  });

  const unratedMinutes = $derived(
    time.timeEntries
      .filter((e) => !e.billedInvoiceId && !e.rate)
      // Null minutes contribute nothing rather than poisoning the sum: on a
      // non-hourly job the duration is optional (TMC-264).
      .reduce((total, e) => total + (e.minutes ?? 0), 0),
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
      <!--
        Asked once per job rather than per entry, because the audience bills the
        same way every time (TMC-264). Submits on change: a select that needs a
        separate save button is a select people leave unsaved.
      -->
      <form method="post" action="?/setBillingUnit">
        <label for="billingUnit" class="sr-only">How this job bills</label>
        <select
          id="billingUnit"
          name="billingUnit"
          value={unit}
          onchange={(e) => (e.currentTarget as HTMLSelectElement).form?.requestSubmit()}
          class="rounded-sm border border-fg/15 bg-surface-2 px-3 py-1.5 font-mono text-xs uppercase tracking-widest text-fg/60 transition-colors hover:border-accent hover:text-accent"
        >
          {#each BILLING_UNITS as u (u)}
            <option value={u}>by the {u}</option>
          {/each}
        </select>
      </form>
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

<!--
  Closing would take this job out of the default list and its unbilled work with
  it. Asked once, with the amount named, rather than blocked or done silently.
-->
{#if form?.confirmClose}
  <div class="mt-6 rounded-sm border border-accent/40 bg-accent/5 px-4 py-3">
    <p class="text-sm text-fg/80">
      This job still has <span class="font-mono">{fmt(form.confirmClose)}</span> ready to bill.
      Closing it hides the job from the default list, and that money with it.
    </p>
    <form method="post" action="?/setStatus" class="mt-3 flex items-center gap-3">
      <input type="hidden" name="status" value="closed" />
      <input type="hidden" name="confirm" value="true" />
      <button type="submit" class="btn">Close anyway</button>
      <a href="/invoices/new?jobId={job.id}" class="link text-sm">Bill it first</a>
    </form>
  </div>
{/if}

{#if form?.actionError}
  <div class="mt-6 rounded-sm border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger" data-form-error role="alert" tabindex="-1">
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
    <!--
      Money on an invoice that exists but hasn't gone out (TMC-202). It belongs
      HERE rather than in "ready to bill": those hours are already on an invoice,
      so offering them again is what let the same work be billed twice. Shown
      only when there is a draft — a permanent "$0.00 drafted" is noise on the
      overwhelmingly common path where the invoice was sent immediately.
    -->
    <p class="mt-1 text-xs text-fg/50">
      {#if Number(margin.drafted) > 0}
        {fmt(margin.drafted)} drafted, not sent
      {:else}
        &nbsp;
      {/if}
    </p>
  </div>
  <div class="bg-surface-2 px-5 py-4">
    <span class="label">What it cost</span>
    <p class="mt-1 font-mono text-xl tabular-nums text-fg/80">{fmt(margin.costs)}</p>
  </div>
  <div class="bg-surface-2 px-5 py-4">
    <span class="label">Made</span>
    <!--
      A dash, never a number, until something has been billed — exactly the rule
      the per-hour tile below already follows. `billed - costs` with nothing
      billed is the negative of the costs, so a job with $340 of plants and an
      unsent invoice reported a $340 LOSS on work that had simply not been
      charged for yet. The costs are real; the loss was not.
    -->
    <p class="mt-1 font-mono text-xl tabular-nums text-fg">
      {margin.made === null ? '—' : fmt(margin.made)}
    </p>
    <p class="mt-1 text-xs text-fg/50">
      {#if margin.made === null}
        nothing billed yet
      {:else}
        &nbsp;
      {/if}
    </p>
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
  <!--
    Named so the time-card inputs below can submit with it via form=. They sit
    inside their own <details> for presentation, which puts them outside this
    element in the DOM — the attribute is what keeps them one submission.
  -->
  <form
    id="logTimeForm"
    method="post"
    action="?/logTime"
    class="mt-4 grid gap-3 {billsByHour
      ? 'sm:grid-cols-[9.5rem_6rem_8rem_1fr_auto]'
      : 'sm:grid-cols-[9.5rem_6rem_6rem_8rem_1fr_auto]'}"
  >
    <!--
      The job's unit rides along so the action knows which field is the billable
      one without re-reading the job (TMC-264).
    -->
    <input type="hidden" name="billingUnit" value={unit} />
    <div>
      <label for="entryDate" class="label block">Date</label>
      <input id="entryDate" name="entryDate" type="date" value={today} required class="field mt-1" />
    </div>
    {#if billsByHour}
      <div>
        <label for="duration" class="label block">Hours</label>
        <!--
          NOT `required`, unlike before. There are now two ways to supply a
          duration — this box, or the time card below — and a required attribute
          here would block a submission the card has already answered. The action
          rejects an entry with neither.
        -->
        <input
          id="duration"
          name="duration"
          type="text"
          inputmode="decimal"
          placeholder="3.25"
          value={stoppedDuration}
          class="field mt-1"
        />
      </div>
    {:else}
      <!--
        A per-visit, per-night or per-day job bills a COUNT, and that count is
        what goes on the invoice (TMC-264). Defaulted to 1 because one entry is
        almost always one visit — the sitter logging tonight's stay should not
        have to type the number.
      -->
      <div>
        <label for="quantity" class="label block capitalize">
          {billingUnitLabel(unit, '2')}
        </label>
        <input
          id="quantity"
          name="quantity"
          type="text"
          inputmode="decimal"
          placeholder="1"
          value="1"
          required
          class="field mt-1"
        />
      </div>
      <!--
        THE STOPWATCH'S ANSWER ON A NON-HOURLY JOB (TMC-264 asked for one).
        A timer cannot produce a visit count, so it fills this instead: an
        OPTIONAL duration that feeds effective-hourly and never touches what the
        customer is billed. A dog sitter can still learn what a 30-minute visit
        earns her per hour without that number reaching the invoice.
      -->
      <div>
        <label for="duration" class="label block">Time spent</label>
        <input
          id="duration"
          name="duration"
          type="text"
          inputmode="decimal"
          placeholder="optional"
          value={stoppedDuration}
          class="field mt-1"
        />
      </div>
    {/if}
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

  <!--
    The stopwatch, behind a disclosure. Typing a duration is the path that
    actually gets used — the timer has to be remembered at the START of the work,
    which is exactly when nobody is thinking about an app. So it is available,
    not urged.

    Open by default only while one is running, so a timer you left going is never
    hidden behind a closed fold.
  -->
  <!--
    The time card, presented exactly as the stopwatch is because the owner named
    it as the model: a sibling disclosure, closed by default, with the plain
    field above staying primary.

    Open when it is holding something, so a half-typed card is never hidden
    behind a closed fold — the same rule the stopwatch follows.
  -->
  <details class="mt-4" open={Boolean(cardStart || cardEnd)}>
    <summary class="label cursor-pointer select-none hover:text-accent">
      Type a start and end time
    </summary>
    <div class="mt-3 flex flex-wrap items-end gap-3">
      <div>
        <label for="startTime" class="label block">Started</label>
        <input
          id="startTime"
          name="startTime"
          type="time"
          form="logTimeForm"
          bind:value={cardStart}
          class="field mt-1"
        />
      </div>
      <div>
        <label for="endTime" class="label block">Finished</label>
        <input
          id="endTime"
          name="endTime"
          type="time"
          form="logTimeForm"
          bind:value={cardEnd}
          class="field mt-1"
        />
      </div>
      {#if cardSummary}
        <p class="pb-2 text-sm text-fg/70">{cardSummary}</p>
      {/if}
    </div>
    <p class="mt-2 text-xs text-fg/50">
      {#if billsByHour}
        Filling these in wins over the hours box above.
      {:else}
        Optional. It records how long the work took, which is what the effective
        hourly figure is worth{billsByHour ? '' : ' — it does not change what gets billed'}.
      {/if}
    </p>
  </details>

  <details class="mt-4" open={Boolean(timer)}>
    <summary class="label cursor-pointer select-none hover:text-accent">Use a stopwatch</summary>
    <div class="mt-3">
      {#if timerOnThisJob}
        <form method="post" action="?/stopTimer" class="flex items-center gap-3">
          <span class="font-mono text-2xl tabular-nums text-accent">{elapsed}</span>
          <button type="submit" class="btn">Stop</button>
          <span class="text-xs text-fg/50">Stopping fills in the hours — it doesn't log them.</span>
        </form>
      {:else if timer}
        <!--
          Held by another job. Naming it and linking there is the whole point:
          the user is standing at THIS job and the thing blocking them is
          somewhere else. Auto-stopping the other one would silently log it with
          the drive in between inside it.
        -->
        <p class="text-sm text-fg/70">
          Running on <a href="/jobs/{timer.jobId}" class="link">{timer.jobName}</a> for {elapsed}.
          Stop it there first — only one timer runs at a time, or the same minute
          gets billed to two customers.
        </p>
      {:else}
        <form method="post" action="?/startTimer">
          <button type="submit" class="btn">Start</button>
        </form>
      {/if}
      {#if form?.timerError}
        <p class="mt-2 text-xs text-danger">{form.timerError}</p>
      {/if}
    </div>
  </details>
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
        <span class="w-20 shrink-0 font-mono tabular-nums text-fg/80">
          {entryAmountLabel(entry)}
        </span>
        <!--
          A time-card entry says when it ran (TMC-265). Typed and stopwatch
          entries have no clock times and render nothing here.
        -->
        {#if entry.startTime && entry.endTime}
          <span class="w-36 shrink-0 text-xs text-fg/50">
            {formatClockTime(entry.startTime)} to {formatClockTime(entry.endTime)}
          </span>
        {/if}
        <span class="min-w-0 flex-1 truncate text-fg/70">{entry.note ?? ''}</span>
        <!--
          What these hours are worth, and what they'll bill at. Silent when no
          rate was set — those hours count toward the job's time without being
          charged, and a "$0.00/h" there would look like a mistake.
        -->
        {#if entry.rate}
          <span class="shrink-0 text-right font-mono tabular-nums text-fg/60">
            ${formatUnitPrice(entry.rate)}/{billingUnitLabel(unit, '1')}
            <span class="ml-2 text-fg/80">
              {fmt(entryValue(entry, entry.rate))}
            </span>
          </span>
        {/if}
        {#if entry.billedInvoiceId}
          <span class="label text-fg/40">Billed</span>
        {:else if canWrite}
          <!--
            Only ever rendered for unbilled hours — the API 409s on a billed
            entry — so the confirmation can promise the books are untouched.
          -->
          <ConfirmSubmit
            action="?/deleteTime"
            label="Remove"
            title="Remove these hours?"
            confirmLabel="Remove hours"
            hidden={{ id: entry.id }}
            triggerClass="link text-xs"
          >
            {#snippet body()}
              The {entryAmountLabel(entry)} logged on {entry.entryDate} is deleted for good — there is
              no undo, so you would be typing the date, the hours, the rate and the note in again. It
              comes off this job's hours{entry.rate ? " and off what's ready to bill" : ''}. These
              hours aren't on an invoice, so nothing changes on your books.
            {/snippet}
          </ConfirmSubmit>
        {/if}
      </li>
    {/each}
  </ul>
  <p class="mt-3 text-sm text-fg/60">{time.totalHours} hours in total.</p>
{/if}

<!--
  Miles (TMC-179). Its own heading and its own form, NEVER a field on the Hours
  form above. Hours produce revenue and miles produce a deduction; in a form
  they look identical, and mixing them is how someone bills a customer for a
  drive. It also sits below the margin block on purpose — mileage is a tax
  figure, not a job cost, and it does not move the margin.
-->
<h2 class="mt-10 font-serif text-2xl font-light text-fg">Miles</h2>
<p class="mt-1 text-sm text-fg/60">
  Driving to this job. Counts toward your vehicle deduction, not this job's cost.
</p>

{#if canWrite}
  <form method="post" action="?/logMiles" class="mt-4 rounded-sm border border-fg/15 bg-surface-2 p-5">
    <div class="grid gap-4 sm:grid-cols-[9rem_7rem_1fr_9rem_auto] sm:items-end">
      <label class="block">
        <span class="label">Date</span>
        <input
          type="date"
          name="tripDate"
          required
          value={new Date().toISOString().slice(0, 10)}
          class="field mt-1 w-full"
        />
      </label>
      <label class="block">
        <span class="label">Miles</span>
        <input
          type="text"
          inputmode="decimal"
          name="miles"
          required
          placeholder="24.5"
          class="field mt-1 w-full"
        />
      </label>
      <label class="block">
        <span class="label">What for</span>
        <input
          type="text"
          name="purpose"
          required
          value="Drove to {job.name}"
          class="field mt-1 w-full"
        />
      </label>
      <!--
        Which vehicle. Without this every trip logged here would land unassigned
        — in the deduction but in no Part IV row — and the worksheet would then
        tell the user to go and fix it. Defaults to the one last driven to this
        job, else the only vehicle there is, so the common case is no work.
      -->
      <label class="block">
        <span class="label">Vehicle</span>
        <select name="vehicleId" class="field mt-1 w-full">
          <option value="">—</option>
          {#each data.vehicles as v (v.id)}
            <option value={v.id} selected={defaultVehicleId === v.id}>{v.label}</option>
          {/each}
        </select>
      </label>
      <button type="submit" class="btn">Log</button>
    </div>
    {#if form?.milesError}
      <p class="mt-3 text-xs text-danger">{form.milesError}</p>
    {/if}
  </form>
{/if}

{#if data.trips.length > 0}
  <ul class="mt-4 divide-y divide-fg/10 rounded-sm border border-fg/10 bg-surface-2">
    {#each data.trips as trip (trip.id)}
      <li class="flex items-center justify-between gap-4 px-5 py-3 text-sm">
        <span class="text-fg/80">
          {trip.tripDate} · {trip.purpose}{data.vehicles.find((v) => v.id === trip.vehicleId)?.label
            ? ` · ${data.vehicles.find((v) => v.id === trip.vehicleId)?.label}`
            : ''}
        </span>
        <span class="font-mono tabular-nums text-fg/70">
          {Number(trip.miles).toLocaleString('en-US', { maximumFractionDigits: 1 })} mi
        </span>
      </li>
    {/each}
  </ul>
  <p class="mt-3 text-sm text-fg/60">
    <a href="/mileage" class="link">All your driving →</a>
  </p>
{/if}

{#if canWrite && job.invoices.length === 0 && time.timeEntries.length === 0}
  <!--
    A hard delete of the row (TMC-217). Reachable only for an empty job, but
    "empty" is checked on invoices and hours alone — receipt tags cascade away
    with it and trips are detached, so the confirmation names both.
  -->
  <ConfirmSubmit
    action="?/delete"
    label="Delete this job"
    title="Delete this job?"
    confirmLabel="Delete job"
    triggerClass="link text-xs text-danger"
    formClass="mt-10"
  >
    {#snippet body()}
      The job is gone for good — there is no undo, and you would have to set it up again. Receipts
      you tagged to it go back to untagged, and miles you logged against it stay in your mileage log
      and still count toward your deduction; they just stop being attached to a job. Nothing changes
      on your books.
      {#if timerOnThisJob}
        The stopwatch you have running on this job goes with it, and those minutes aren't logged
        anywhere.
      {/if}
    {/snippet}
  </ConfirmSubmit>
  <p class="mt-1 text-xs text-fg/50">
    Only while it's empty. Once it has hours or invoices, close it instead.
  </p>
{/if}

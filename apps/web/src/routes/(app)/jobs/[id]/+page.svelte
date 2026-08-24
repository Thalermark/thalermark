<script lang="ts">
  import { untrack } from 'svelte';
  import ConfirmSubmit from '$lib/components/ConfirmSubmit.svelte';
  import { may } from '$lib/perms';
  import {
    BILLING_UNITS,
    billingUnitLabel,
    entryUnit,
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
  // The job's DEFAULT unit. Not the answer for any given line any more — one
  // job can mix them, so every read below resolves through entryUnit().
  const jobUnit = $derived(time.billingUnit);

  // What the line being typed right now bills in. Seeded from the job, then the
  // user's to change per entry. untrack() because this reads the job's default
  // ONCE, on arrival: following it would overwrite a deliberate override every
  // time the job reloaded.
  let lineUnit = $state<string>(untrack(() => form?.typed?.unit ?? time.billingUnit));
  const billsByHour = $derived(lineUnit === 'hour');
  // "Hours" was hard-coded, which read as a lie on a job billing by the visit.
  // Capitalised at render because the labels are lowercase nouns.
  const workHeading = $derived(
    `${billingUnitLabel(jobUnit, '2').charAt(0).toUpperCase()}${billingUnitLabel(jobUnit, '2').slice(1)}`,
  );

  // What one entry contributes, in whatever the job bills in. Null when it
  // records nothing billable — an hourly entry with no duration, or a per-visit
  // entry with no count.
  function entryQty(entry: { minutes: number | null; quantity: string | null }): string | null {
    return timeEntryQuantity(entry, jobUnit);
  }

  // How an entry reads in the list: "3.25 h" on an hourly job, "3 visits"
  // otherwise.
  // Each row reads in the unit IT was logged in, not the job's and not the one
  // currently selected in the form above. A list that relabels itself when you
  // change the form's picker would be describing the wrong thing.
  function entryAmountLabel(entry: {
    minutes: number | null;
    quantity: string | null;
    unit: string | null;
  }): string {
    const u = entryUnit(entry, jobUnit);
    if (u === 'hour') return `${hours(entry.minutes)} h`;
    const qty = entry.quantity ?? '0';
    return `${formatQuantity(qty)} ${billingUnitLabel(u, qty)}`;
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

  // EVERY PER-ENTRY FIELD IS BOUND, so Clear can empty them and so a stopped
  // stopwatch can seed one without freezing anything. Date and rate are
  // deliberately NOT here: they are sticky defaults that survive an entry, and
  // clearing them would make logging a second entry harder than the first.
  // Seeded, not assigned by an effect. Every action on this page is a plain form
  // POST — there is no use:enhance anywhere here — so a stop is a full page load
  // and this component is rebuilt with the result in `form`. A $state initialiser
  // runs exactly once per mount, which is precisely the "seed it once" semantics
  // an effect was being used to fake.
  // Restored from a rejected submit when there is one, otherwise seeded from a
  // stopwatch stop, otherwise empty. A failed entry used to lose everything the
  // user typed, because a plain POST re-renders the page and these reset.
  let duration = $state(
    untrack(
      () =>
        form?.typed?.duration ??
        (form?.stoppedMinutes
          ? (Math.round((form.stoppedMinutes / 60) * 100) / 100).toFixed(2)
          : ''),
    ),
  );
  let note = $state(untrack(() => form?.typed?.note ?? ''));
  let cardStart = $state(untrack(() => form?.typed?.startTime ?? ''));
  let cardEnd = $state(untrack(() => form?.typed?.endTime ?? ''));

  const hasEntryInput = $derived(Boolean(duration || note || cardStart || cardEnd));

  function clearEntry() {
    duration = '';
    note = '';
    cardStart = '';
    cardEnd = '';
    // The mode is deliberately LEFT ALONE. Clearing while in Start & end almost
    // always means "I typed the wrong times", so snapping back to Duration would
    // take away the very input they were about to reuse.
    // Belt and braces: reset the form ELEMENT as well, so anything uncontrolled
    // in the row (the date, the rate, the count) returns to the default it was
    // rendered with rather than whatever was typed over it. Without this Clear
    // silently means "clear some of it".
    document.querySelector<HTMLFormElement>('#logTimeForm')?.reset();
  }

  // The time card (TMC-265). A third way in, beside the duration box and the
  // stopwatch, and the only one that is both after-the-fact AND arithmetic-free:
  // the duration field needs mental maths, and the stopwatch has to be
  // remembered at the START of the work, which is exactly when nobody is
  // thinking about an app.
  // WHICH INPUT IS ON SCREEN. The three modes are exclusive by construction —
  // only the chosen one is rendered — which is what removes the precedence rule
  // the old layout had to explain in prose.
  const LOG_MODES = [
    { key: 'duration', label: 'Duration' },
    { key: 'card', label: 'Start & end' },
    { key: 'stopwatch', label: 'Stopwatch' },
  ] as const;
  // NO OVERRIDE. `mode` is whatever the user last picked, full stop, and the
  // selector is therefore always live.
  //
  // It used to be `timerOnThisJob ? 'stopwatch' : logMode`, which LOCKED the
  // selector for as long as a timer ran: clicks set logMode and the ternary
  // discarded them, so the buttons rendered as if they worked and did nothing.
  // A seeding $effect sat on top of that and made it worse — it compared
  // `form !== seededFrom` where seededFrom was $state, and Svelte 5 wraps an
  // object assigned into $state in a proxy, so that identity check can never
  // become false and the effect kept forcing the mode back.
  //
  // Both existed to serve one honest requirement: never HIDE a running timer.
  // That is a question about what to show on ARRIVAL, so it belongs in the
  // initialiser below, not in a rule that outranks the user forever after.
  // untrack() states the intent Svelte would otherwise only warn about: this
  // reads the value ONCE, on arrival, and deliberately does not follow it. A
  // derived here would be the bug we just removed.
  let logMode = $state<(typeof LOG_MODES)[number]['key']>(
    untrack(() => {
      // A rejected time-card submit comes back to the time card, not to Duration
      // — otherwise the restored clock times are sitting in a mode that does not
      // render them, which reads as the entry having been eaten.
      if (form?.typed?.startTime || form?.typed?.endTime) return 'card';
      return timer?.jobId === job.id ? 'stopwatch' : 'duration';
    }),
  );
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
          value={jobUnit}
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

<h2 class="mt-10 font-serif text-2xl font-light text-fg">{workHeading}</h2>

{#if canWrite}
  <!--
    ONE WAY IN AT A TIME.

    Three input modes used to be on screen at once: a duration box, a time-card
    disclosure and a stopwatch disclosure. Two of them wrote the same field, so
    the page had to explain its own precedence ("Filling these in wins over the
    hours box above") — a sentence that only exists because two controls mean
    the same thing and one silently beats the other. The owner rejected that
    flow on sight.

    Picking the mode makes the modes exclusive. Only the chosen inputs are
    rendered, so there is no precedence left to explain, no hint text, and no
    way to fill two fields that disagree. The action still resolves a card ahead
    of a duration, but that is now a belt-and-braces guard rather than a rule the
    user has to know.
  -->
  <!--
    WHAT THIS LINE BILLS IN (TMC-264, revised).

    The unit began on the job, asked once and inherited. That holds for a lawn
    crew and breaks for the audience the feature was built for: a sitter charges
    a flat rate for a drop-in visit AND an hourly rate when she stays the
    afternoon, on one job for one customer.

    So it is per line, seeded from the job's default — which is why the job-level
    picker at the top of the page survives. Answering it once still covers the
    common case; this row is the exception to it.
  -->
  <div class="mt-4 flex flex-wrap items-center gap-2">
    <span class="label">This line bills by the</span>
    {#each BILLING_UNITS as u (u)}
      <button
        type="button"
        onclick={() => (lineUnit = u)}
        aria-pressed={lineUnit === u}
        class="rounded-sm border px-3 py-1 font-mono text-xs uppercase tracking-widest transition-colors {lineUnit ===
        u
          ? 'border-accent text-accent'
          : 'border-fg/15 text-fg/60 hover:border-fg/40 hover:text-fg'}"
      >
        {u}
      </button>
    {/each}
    {#if lineUnit !== jobUnit}
      <button
        type="button"
        onclick={() => (lineUnit = jobUnit)}
        class="link text-xs"
        title="Back to what this job usually bills by"
      >
        Reset to {jobUnit}
      </button>
    {/if}
  </div>

  <div class="mt-3 flex flex-wrap items-center gap-2">
    <span class="label">How long?</span>
    {#each LOG_MODES as m (m.key)}
      <button
        type="button"
        onclick={() => (logMode = m.key)}
        aria-pressed={logMode === m.key}
        class="rounded-sm border px-3 py-1 font-mono text-xs uppercase tracking-widest transition-colors {logMode ===
        m.key
          ? 'border-accent text-accent'
          : 'border-fg/15 text-fg/60 hover:border-fg/40 hover:text-fg'}"
      >
        {m.label}
      </button>
    {/each}
    <!--
      The selector no longer forces itself to Stopwatch while a timer runs, so a
      timer could otherwise be left running out of sight. On ARRIVAL the
      initialiser opens on Stopwatch; after that the user is free to look
      elsewhere, and this says the timer is still going while they do.
    -->
    {#if timerOnThisJob && logMode !== 'stopwatch'}
      <button
        type="button"
        onclick={() => (logMode = 'stopwatch')}
        class="font-mono text-xs uppercase tracking-widest text-accent hover:underline"
      >
        Timer running · {elapsed}
      </button>
    {/if}
  </div>

  <!--
    Flex rather than a fixed grid: the field set changes with the mode and with
    the job's billing unit, and column maths for every permutation is how a
    layout ends up with an empty cell where a field used to be.
  -->
  <form id="logTimeForm" method="post" action="?/logTime" class="mt-3 flex flex-wrap gap-3">
    <!--
      The unit THIS LINE bills in, which may differ from the job's default. The
      action needs it to know which field is the billable one.
    -->
    <input type="hidden" name="unit" value={lineUnit} />
    <div class="w-36">
      <label for="entryDate" class="label block">Date</label>
      <input id="entryDate" name="entryDate" type="date" value={today} required class="field mt-1" />
    </div>

    {#if !billsByHour}
      <!--
        A per-visit, per-night or per-day job bills a COUNT, and that count is
        what reaches the invoice (TMC-264). Always shown, whatever the mode:
        the mode picks how the DURATION is entered, and on these jobs the
        duration is only ever optional context for effective-hourly.
      -->
      <div class="w-28">
        <label for="quantity" class="label block capitalize whitespace-nowrap">
          {billingUnitLabel(lineUnit, '2')}
        </label>
        <input
          id="quantity"
          name="quantity"
          type="text"
          inputmode="decimal"
          placeholder="1"
          value={form?.typed?.quantity || '1'}
          required
          class="field mt-1"
        />
      </div>
    {/if}

    {#if logMode === 'card'}
      <div class="w-32">
        <label for="startTime" class="label block">Started</label>
        <input
          id="startTime"
          name="startTime"
          type="time"
          bind:value={cardStart}
          class="field mt-1"
        />
      </div>
      <div class="w-32">
        <label for="endTime" class="label block">Finished</label>
        <input id="endTime" name="endTime" type="time" bind:value={cardEnd} class="field mt-1" />
      </div>
    {:else if logMode === 'stopwatch'}
      <!--
        THE TIMER SITS IN THE ROW, not in a block underneath it.

        It used to render below the form, which left the duration box still
        showing in the row above while the stopwatch lived somewhere else
        entirely — two controls for one number, visually unrelated, which is the
        same disconnection the mode selector was supposed to end.

        `formaction` rather than a nested <form>: nesting is illegal HTML, and
        these buttons want the main form's element without its action. Neither
        timer action reads any field, so carrying the row's data along is
        harmless. `formnovalidate` because starting a timer must not be blocked
        by a required field somewhere else in the row.
      -->
      <!--
        NOT `.btn`. Log is this form's submit and has to stay the loudest thing
        in it; a filled Start sitting beside a filled Log made the secondary
        action read as the primary one. Outlined, matching the mode chips above
        and the Close job control at the top of the page.

        No "Stopwatch" label either — the selected chip directly above already
        says that, and repeating it labelled the button with the mode rather
        than with anything the user did not already know. Only the running state
        gets a label, because the elapsed figure beside it needs one.
      -->
      <!--
        ALIGNMENT IS PER STATE, not one wrapper for all three.

        A `flex items-end` around the lot bottom-aligned this cell inside a row
        the date input stretches taller, which pushed the Running label ~24px
        below DATE and RATE. Every other cell is top-aligned, and that is exactly
        what lines their labels up.

        So the labelled state is a plain cell like its neighbours, and only the
        bare buttons get `self-end` — with no label above them they would
        otherwise float at the top of the row instead of sitting level with the
        input boxes.
      -->
      {#if timerOnThisJob}
        <!--
          flex-col + flex-1 rather than a height matching `.field`. The cell
          already stretches to the row's height (the form's align-items is the
          default stretch), so letting the control row claim what is left under
          the label and centre inside it puts the elapsed figure on the inputs'
          own centre line — without this file having to know what `.field`
          resolves to, or having to be edited again when it changes.
        -->
        <div class="flex flex-col">
          <span class="label block">Running</span>
          <div class="mt-1 flex flex-1 items-center gap-3">
            <span class="font-mono text-2xl leading-none tabular-nums text-accent">{elapsed}</span>
            <button
              type="submit"
              formaction="?/stopTimer"
              formnovalidate
              class="rounded-sm border border-accent px-4 py-2 font-mono text-xs uppercase tracking-widest text-accent transition-colors hover:bg-accent/10"
            >
              Stop
            </button>
          </div>
        </div>
      {:else if timer}
        <button
          type="button"
          disabled
          class="self-end rounded-sm border border-fg/15 px-4 py-2 font-mono text-xs uppercase tracking-widest text-fg/40"
        >
          Running elsewhere
        </button>
      {:else}
        <button
          type="submit"
          formaction="?/startTimer"
          formnovalidate
          class="self-end rounded-sm border border-fg/25 px-4 py-2 font-mono text-xs uppercase tracking-widest text-fg/70 transition-colors hover:border-accent hover:text-accent"
        >
          Start
        </button>
      {/if}
    {:else}
      <!--
        w-28. The label is short enough not to need more, which is the better
        fix than the wide cell that preceded it: "Time spent (hours)" wrapped in
        a w-24 box, made the cell taller, and pushed its input BELOW the boxes
        either side — the same misalignment the Running label had.

        whitespace-nowrap keeps that failure loud. If the copy ever outgrows the
        cell again it overflows visibly rather than quietly dropping a field out
        of the row, which is the version that took a screenshot to notice.
      -->
      <div class="w-28">
        <!--
          "Hours" IN BOTH BRANCHES, because it is hours in both. The non-hourly
          branch used to say "Time spent" with a placeholder of "optional",
          naming neither the unit nor a format — so someone billing by the job
          typed "30" for half an hour, got 30 HOURS, blew the one-day cap, and
          was shown a generic error (owner report, 2026-08-23).

          Naming the unit is the whole fix, and it belongs on the LABEL. That
          frees the placeholder to carry the other difference between the two
          branches — whether the field is required at all.

          Cost, accepted: "0:30" also advertised the h:mm form the parser has
          always taken, and nobody discovers that on their own. With the label
          saying Hours, half an hour is "0.5", which is the natural thing to
          type anyway.
        -->
        <label for="duration" class="label block whitespace-nowrap">Hours</label>
        <!--
          Not `required` even on an hourly job: the stopwatch mode fills this
          after the fact, and the action rejects an entry that records nothing.
        -->
        <input
          id="duration"
          name="duration"
          type="text"
          inputmode="decimal"
          placeholder={billsByHour ? '3.25' : 'optional'}
          bind:value={duration}
          class="field mt-1"
        />
      </div>
    {/if}

    <div class="w-28">
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
        value={form?.typed?.rate ?? lastRate}
        class="field mt-1"
      />
    </div>
    <!--
      Its own row. Sharing one with Date / Hours / Rate squeezed it to whatever
      was left over, which on a non-hourly job (one field wider) was a box too
      narrow to read back what you had typed. It is also the only free-text
      field here, so it is the one that actually benefits from the width.
    -->
    <div class="w-full">
      <label for="note" class="label block">What you did</label>
      <input
        id="note"
        name="note"
        type="text"
        maxlength="1000"
        bind:value={note}
        class="field mt-1"
      />
    </div>
  </form>

  {#if logMode === 'card' && cardSummary}
    <!--
      The computed span, stated before anything is submitted. That sighting is
      the "confirm" half of the owner's detect-and-confirm call on an overnight
      shift: no modal, no second question.
    -->
    <p class="mt-2 text-sm text-fg/70">{cardSummary}</p>
  {/if}

  {#if logMode === 'stopwatch'}
    <!--
      Only what will not fit in a row cell. The controls themselves are up in the
      row; this is the sentence that has to be readable, and the one that has to
      link somewhere.
    -->
    {#if timerOnThisJob}
      <p class="mt-2 text-xs text-fg/50">Stopping fills in the hours — it doesn't log them.</p>
    {:else if timer}
      <!--
        Held by another job. Naming it and linking there is the whole point: the
        user is standing at THIS job and the thing blocking them is somewhere
        else. Auto-stopping the other one would silently log it with the drive in
        between inside it.
      -->
      <p class="mt-2 text-sm text-fg/70">
        Running on <a href="/jobs/{timer.jobId}" class="link">{timer.jobName}</a> for {elapsed}. Stop
        it there first — only one timer runs at a time, or the same minute gets billed to two
        customers.
      </p>
    {/if}
    {#if form?.timerError}
      <p class="mt-2 text-xs text-danger">{form.timerError}</p>
    {/if}
  {/if}

  {#if form?.timeError}
    <p class="mt-3 text-xs text-danger" data-form-error role="alert">{form.timeError}</p>
  {/if}

  <!-- After every way of filling the form, never above one of them. -->
  <div class="mt-3 flex items-center gap-3">
    <button type="submit" form="logTimeForm" class="btn">Log</button>
    <!--
      Shown only when there is something to clear, so it never sits there as an
      inert control on an empty form. It empties the per-entry fields and leaves
      the date and the rate alone — those are sticky defaults, and wiping them
      would make the second entry of a session harder to type than the first.

      type="button" is load-bearing: a bare <button> inside a form defaults to
      submit, which would log the entry it is meant to discard.
    -->
    <!--
      ALWAYS RENDERED, disabled when there is nothing to clear, rather than
      appearing and vanishing. A control that disappears the moment it works
      cannot be told apart from one that did nothing — which is exactly how this
      was reported.
    -->
    <button
      type="button"
      onclick={clearEntry}
      disabled={!hasEntryInput}
      class="link text-sm disabled:cursor-default disabled:opacity-40 disabled:hover:no-underline"
    >
      Clear
    </button>
  </div>
  <p class="mt-2 text-xs text-fg/50">
    Leave the rate blank for work you're not charging for — it still counts toward what the job cost
    you in time.
  </p>
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
            ${formatUnitPrice(entry.rate)}/{billingUnitLabel(entryUnit(entry, jobUnit), '1')}
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

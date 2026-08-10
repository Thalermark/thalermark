<script lang="ts">
  import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
  import ConfirmSubmit from '$lib/components/ConfirmSubmit.svelte';
  import LoadMore from '$lib/components/LoadMore.svelte';
  import { fetchMore } from '$lib/load-more';
  import { may } from '$lib/perms';
  import { mileageValue, standardMileageRateFor } from '@thalermark/validation';
  import { untrack } from 'svelte';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();

  const canWrite = $derived(may(data.role, 'expenses:write'));
  const summary = $derived(data.summary);

  const fmt = (s: string) =>
    Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  // Miles are stored at 4dp so valuation multiplies exactly; nobody wants to
  // read "24.5000".
  const miles = (s: string) => Number(s).toLocaleString('en-US', { maximumFractionDigits: 1 });

  type Row = (typeof data.trips)[number];
  let rows = $state<Row[]>(untrack(() => data.trips));
  let cursor = $state<string | null>(untrack(() => data.nextCursor));
  let loading = $state(false);
  let loadError = $state(false);

  $effect(() => {
    const nextRows = data.trips;
    const next = data.nextCursor;
    untrack(() => {
      rows = nextRows;
      cursor = next;
    });
  });

  async function more() {
    if (loading || cursor === null) return;
    loading = true;
    loadError = false;
    try {
      const page = await fetchMore<Row>('/mileage/more', cursor);
      rows = [...rows, ...page.rows];
      cursor = page.nextCursor;
    } catch {
      loadError = true;
    } finally {
      loading = false;
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const vehicles = $derived(data.vehicles);
  const vehicleName = $derived(
    (id: string | null) => vehicles.find((v) => v.id === id)?.label ?? null,
  );
  // Prefill from the last trip, falling back to the only vehicle there is. One
  // truck is the common case, so picking it every time is pure friction.
  const defaultVehicleId = $derived(
    rows[0]?.vehicleId ?? (vehicles.length === 1 ? vehicles[0]?.id : '') ?? '',
  );
  // Part IV can't be finished without these, so the page says so rather than
  // waiting for April. A work-only vehicle answers once and is done for good.
  const needsAnswers = $derived(
    vehicles.filter((v) => v.personalUse === null || v.placedInServiceOn === null),
  );
  const todayRate = standardMileageRateFor(today);

  // Retiring a vehicle (TMC-217). This one confirmation cannot use ConfirmSubmit:
  // the trigger is a submit button INSIDE the saveVehicle form, retargeted with
  // formaction, and the Part IV fields ride along with it. Giving it a form of
  // its own would change what gets posted, so the dialog is wired by hand.
  //
  // One dialog for however many vehicles are listed, not one per row: the click
  // records WHICH button asked, and the same dialog then speaks for that row.
  // Only one can be open at a time, so a <dialog> per truck plus an open flag
  // keyed by id would be machinery with nothing to show for it.
  let retireOpen = $state(false);
  let retireBtn: HTMLButtonElement | null = $state(null);
  let retireLabel = $state('');
</script>

<div class="flex flex-wrap items-baseline justify-between gap-4">
  <h1 class="font-serif text-3xl text-fg">Mileage</h1>
  {#if summary}
    <!--
      The heading carries DOLLARS, not miles. Miles are the input; what the user
      wants to know is what the driving is worth, and it is routinely the biggest
      deduction on their return.
    -->
    <p class="text-right">
      <span class="font-mono text-2xl tabular-nums text-accent">{fmt(summary.amount)}</span>
      <span class="label ml-2">{miles(summary.miles)} miles in {data.year}</span>
    </p>
  {/if}
</div>

<p class="mt-2 max-w-2xl text-sm text-fg/70">
  Business driving, at the IRS standard rate. Logging a trip records a deduction — it never moves
  money, so nothing here touches your books.
</p>

{#if summary && Number(summary.unratedMiles) > 0}
  <!--
    Miles we cannot price. Saying so is the point: quietly valuing them at last
    year's rate would produce a number that looks right and is wrong on a return.
  -->
  <div class="callout mt-6">
    <p>
      {miles(summary.unratedMiles)} miles are on dates the IRS hasn't published a rate for yet, so they're
      not in the total above. They'll be counted as soon as the rate is out.
    </p>
  </div>
{/if}

{#if canWrite}
  <form method="POST" action="?/log" class="mt-8 rounded-sm border border-fg/15 bg-surface-2 p-5">
    <div class="grid gap-4 sm:grid-cols-[9rem_7rem_1fr_9rem_auto] sm:items-end">
      <label class="block">
        <span class="label">Date</span>
        <input
          type="date"
          name="tripDate"
          required
          value={form?.values?.tripDate ?? today}
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
          value={form?.values?.miles ?? ''}
          class="field mt-1 w-full"
        />
      </label>
      <label class="block">
        <span class="label">What for</span>
        <input
          type="text"
          name="purpose"
          required
          placeholder="Drove to the Miller place"
          value={form?.values?.purpose ?? ''}
          class="field mt-1 w-full"
        />
      </label>
      <label class="block">
        <span class="label">Vehicle</span>
        <select name="vehicleId" class="field mt-1 w-full">
          <!-- Blank is allowed: a trip logged before any vehicle is set up is
               still a real deduction. Those miles show up as unassigned on the
               worksheet rather than being dropped. -->
          <option value="">—</option>
          {#each vehicles as v (v.id)}
            <option value={v.id} selected={(form?.values?.vehicleId ?? defaultVehicleId) === v.id}>
              {v.label}
            </option>
          {/each}
        </select>
      </label>
      <button type="submit" class="btn">Log</button>
    </div>

    {#if form?.fieldErrors?.purpose}
      <p class="mt-3 text-sm text-danger">
        Say what the trip was for — that's what makes the deduction stick if it's ever questioned.
      </p>
    {:else if form?.fieldErrors?.miles}
      <p class="mt-3 text-sm text-danger">Enter the miles driven, as a number.</p>
    {:else if form?.formError}
      <p class="mt-3 text-sm text-danger">{form.formError}</p>
    {:else if form?.logged}
      <p class="mt-3 text-sm text-fg/60">Logged.</p>
    {/if}

    {#if todayRate}
      <p class="mt-3 text-xs text-fg/50">
        Today's rate is {Number(todayRate).toFixed(3).replace(/0$/, '')} per mile.
      </p>
    {/if}
  </form>
{/if}

{#if rows.length === 0}
  <p class="mt-8 text-fg/70">No trips logged yet.</p>
{:else}
  <ul class="mt-6 divide-y divide-fg/10 rounded-sm border border-fg/10 bg-surface-2">
    {#each rows as trip (trip.id)}
      {@const value = mileageValue(trip.miles, trip.tripDate)}
      <li class="flex items-center justify-between gap-4 px-5 py-4">
        <span class="min-w-0 flex-1">
          <span class="font-serif text-lg text-fg">{trip.purpose}</span>
          <span class="label mt-1 block">
            {trip.tripDate} · {miles(trip.miles)} miles{vehicleName(trip.vehicleId)
              ? ` · ${vehicleName(trip.vehicleId)}`
              : ''}
          </span>
        </span>
        <span class="shrink-0 text-right">
          {#if value}
            <span class="font-mono tabular-nums text-fg">{fmt(value)}</span>
          {:else}
            <span class="label">no rate yet</span>
          {/if}
        </span>
        {#if canWrite}
          <span class="flex shrink-0 items-center gap-3">
            <!--
              "Again" is the frequent-route shortcut: the same drive, today.
              Posting through the ordinary log action keeps one write path.
            -->
            <form method="POST" action="?/log">
              <input type="hidden" name="tripDate" value={today} />
              <input type="hidden" name="miles" value={trip.miles} />
              <input type="hidden" name="purpose" value={trip.purpose} />
              <input type="hidden" name="vehicleId" value={trip.vehicleId ?? ''} />
              <button type="submit" class="link text-sm">Again</button>
            </form>
            <ConfirmSubmit
              action="?/remove"
              label="Delete"
              title="Delete this trip?"
              confirmLabel="Delete trip"
              hidden={{ id: trip.id }}
              triggerClass="link text-sm text-fg/50"
            >
              {#snippet body()}
                The {miles(trip.miles)} miles on {trip.tripDate} come off your mileage log and out of
                your deduction{value ? `, ${fmt(value)} of it` : ''}. There is no undo — you would
                have to log the drive again from scratch. It doesn't touch your books; mileage never
                moves money.
              {/snippet}
            </ConfirmSubmit>
          </span>
        {/if}
      </li>
    {/each}
  </ul>
  <LoadMore hasMore={cursor !== null} {loading} error={loadError} onclick={more} />
{/if}

<!--
  Vehicles, and the Schedule C Part IV answers that belong to them rather than to
  a year. Here rather than in Settings on purpose: the trip form needs the picker
  anyway, and Settings is gated on settings:manage which `accountant` does not
  hold — and the accountant is often exactly who finishes Part IV.
-->
{#if canWrite}
  <h2 class="mt-12 font-serif text-2xl font-light text-fg">Your vehicles</h2>
  <p class="mt-1 max-w-2xl text-sm text-fg/70">
    The IRS asks a few questions about each vehicle you drive for work. Answering them now means
    there's nothing left to work out at tax time.
  </p>

  {#if needsAnswers.length > 0}
    <p class="callout mt-4">
      {needsAnswers.length === 1
        ? `${needsAnswers[0]?.label} is missing some answers.`
        : `${needsAnswers.length} vehicles are missing some answers.`} Your return needs them, so it's
      worth a minute now.
    </p>
  {/if}

  <form method="POST" action="?/addVehicle" class="mt-4 flex flex-wrap items-end gap-3">
    <label class="block">
      <span class="label">Add a vehicle</span>
      <input type="text" name="label" placeholder="F-150" class="field mt-1 w-56" />
    </label>
    <button type="submit" class="btn">Add</button>
    {#if form?.vehicleError}
      <span class="text-sm text-danger">{form.vehicleError}</span>
    {:else if form?.vehicleAdded}
      <span class="text-sm text-fg/60">Added.</span>
    {:else if form?.vehicleSaved}
      <span class="text-sm text-fg/60">Saved.</span>
    {/if}
  </form>

  {#each vehicles as v (v.id)}
    <form
      method="POST"
      action="?/saveVehicle"
      class="mt-4 rounded-sm border border-fg/15 bg-surface-2 p-5"
    >
      <input type="hidden" name="id" value={v.id} />
      <div class="flex flex-wrap items-baseline justify-between gap-3">
        <span class="font-serif text-lg text-fg">{v.label}</span>
        <!--
          Stays a real type="submit" with its formaction: with scripting off the
          POST goes through exactly as it did before, unconfirmed but never
          broken. The click is cancelled and re-issued from the dialog through
          requestSubmit(button), which honours formaction and does not re-fire
          this handler.
        -->
        <button
          type="submit"
          formaction="?/retireVehicle"
          class="link text-xs text-fg/50"
          onclick={(e) => {
            e.preventDefault();
            retireBtn = e.currentTarget;
            retireLabel = v.label;
            retireOpen = true;
          }}
        >
          No longer used
        </button>
      </div>

      <div class="mt-4 grid gap-4 sm:grid-cols-3">
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
            <option value="" selected={v.personalUse === null}>—</option>
            <!--
              'none' is what makes the year-end question disappear for this
              vehicle: its total miles ARE the business miles already logged, so
              there is nothing left to estimate.
            -->
            <option value="none" selected={v.personalUse === 'none'}>No, work only</option>
            <option value="some" selected={v.personalUse === 'some'}>Yes, sometimes</option>
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
      </div>
      <p class="mt-3 max-w-prose text-xs text-fg/50">
        If this is a work-only truck and you drive something else on weekends, that's "No, work
        only" and "Yes" — which is the strongest answer you can give.
      </p>
      <button type="submit" class="btn mt-4">Save</button>
    </form>
  {/each}

  <ConfirmDialog
    bind:open={retireOpen}
    title="Mark {retireLabel} as no longer used?"
    confirmLabel="Retire this vehicle"
    onconfirm={() => retireBtn?.form?.requestSubmit(retireBtn)}
  >
    {#snippet body()}
      Retired, not deleted: every trip you have already logged keeps its miles and stays in your
      deduction, and the vehicle still appears on your tax worksheet for the years it drove. It
      disappears from the vehicle picker, so you can't log any more driving against it.
      <strong class="font-medium text-fg">There is no way to bring it back.</strong> You would have
      to add it again as a new vehicle, and the old trips would stay with this one.
    {/snippet}
  </ConfirmDialog>
{/if}

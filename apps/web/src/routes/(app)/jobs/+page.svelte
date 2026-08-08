<script lang="ts">
  import LoadMore from '$lib/components/LoadMore.svelte';
  import MetricStrip from '$lib/components/MetricStrip.svelte';
  import { fetchMore } from '$lib/load-more';
  import { may } from '$lib/perms';
  import { untrack } from 'svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  const filters = $derived(data.filters);
  const summary = $derived(data.summary);

  const fmt = (s: string) =>
    Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  // Same untrack() seed-and-re-seed pattern as /items and /contacts: load()
  // re-runs whenever a filter changes, and the $effect keeps the list in sync.
  type Row = (typeof data.jobs)[number];
  let rows = $state<Row[]>(untrack(() => data.jobs));
  let cursor = $state<string | null>(untrack(() => data.nextCursor));
  let loading = $state(false);
  let loadError = $state(false);

  $effect(() => {
    const nextRows = data.jobs;
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
      const page = await fetchMore<Row>('/jobs/more', cursor, {
        status: filters.status,
        q: filters.q,
      });
      rows = [...rows, ...page.rows];
      cursor = page.nextCursor;
    } catch {
      loadError = true;
    } finally {
      loading = false;
    }
  }

  // The questions in the order they get asked: what is live, what is finished,
  // how much money is sitting there, and what is stopping the rest from being
  // billed.
  //
  // "Needs a rate" is the actionable one and the reason it earns a tile at all:
  // a job full of unpriced hours looks identical to a job with nothing to bill,
  // so it carries `alert` — the same treatment overdue invoices get.
  const strip = $derived(
    summary
      ? [
          {
            label: 'Open',
            value: summary.open,
            href: '/jobs?status=open',
            active: filters.status === 'open',
          },
          {
            label: 'Closed',
            value: summary.closed,
            href: '/jobs?status=closed',
            active: filters.status === 'closed',
          },
          {
            label: 'Ready to bill',
            value: fmt(summary.readyToBill),
            // Money sitting on CLOSED jobs is called out, because the default
            // list shows open ones: without this the headline can read $191
            // while everything visible adds to $60, and the difference looks
            // like a bug rather than money parked somewhere else. The tile links
            // to every job so the number is always reachable.
            // Drafted money sits BELOW those two and above "nothing waiting"
            // (TMC-202): it is not waiting to be billed — it is already on an
            // invoice — but a bare "$0.00 nothing waiting" is a lie while an
            // unsent invoice exists, and that is the only case where this money
            // is reported nowhere at all.
            sub:
              Number(summary.readyToBillOnClosed) > 0
                ? `${fmt(summary.readyToBillOnClosed)} on closed jobs`
                : summary.jobsWithMoneyWaiting > 0
                  ? `across ${summary.jobsWithMoneyWaiting} ${summary.jobsWithMoneyWaiting === 1 ? 'job' : 'jobs'}`
                  : Number(summary.drafted) > 0
                    ? `${fmt(summary.drafted)} drafted, not sent`
                    : 'nothing waiting',
            href: '/jobs?status=all',
            alert: Number(summary.readyToBillOnClosed) > 0,
          },
          {
            label: 'Needs a rate',
            value: summary.unratedMinutes > 0 ? `${summary.unratedHours} h` : '—',
            sub: summary.unratedMinutes > 0 ? "can't be billed yet" : 'all hours priced',
            href: '/jobs?status=all',
            alert: summary.unratedMinutes > 0,
          },
        ]
      : [],
  );

  function dateRange(startedOn: string | null, endedOn: string | null): string {
    if (startedOn && endedOn) return `${startedOn} → ${endedOn}`;
    if (startedOn) return `Started ${startedOn}`;
    if (endedOn) return `Ended ${endedOn}`;
    return '';
  }
</script>

<div class="flex items-baseline justify-between gap-6">
  <div>
    <span class="eyebrow">Jobs</span>
    <h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-fg">
      All jobs<span class="text-accent">.</span>
    </h1>
  </div>
  {#if may(data.role, 'sales:write')}
    <a href="/jobs/new" class="btn"> + New job </a>
  {/if}
</div>

<p class="mt-3 text-sm text-fg/60">
  A job is whatever you'd call it out loud — “the Smith job”, “Tuesdays at the Chens”. Log hours
  against it, tag what you bought for it, and bill it as many times as you need.
</p>

{#if strip.length > 0}
  <div class="mt-8">
    <MetricStrip tiles={strip} />
  </div>
{/if}

<!-- Filters. Plain GET form so they live in the URL (shareable, back-button
     friendly) and re-run load() with a fresh page 1 — mirrors /invoices. -->
<form
  method="GET"
  class="mt-8 flex flex-wrap items-end gap-3 rounded-sm border border-fg/10 bg-surface-2 p-4"
>
  <label class="flex flex-1 flex-col gap-1 text-xs uppercase tracking-widest text-fg/50">
    Search
    <input
      type="search"
      name="q"
      value={filters.q}
      placeholder="Job name"
      class="min-w-40 rounded-sm border border-fg/15 bg-surface px-2 py-1.5 text-sm normal-case tracking-normal text-fg"
    />
  </label>
  <label class="flex flex-col gap-1 text-xs uppercase tracking-widest text-fg/50">
    Status
    <select
      name="status"
      onchange={(e) => e.currentTarget.form?.requestSubmit()}
      class="rounded-sm border border-fg/15 bg-surface px-2 py-1.5 text-sm normal-case tracking-normal text-fg"
    >
      <option value="open" selected={filters.status === 'open'}>Open</option>
      <option value="closed" selected={filters.status === 'closed'}>Closed</option>
      <option value="all" selected={filters.status === 'all'}>All</option>
    </select>
  </label>
  <button type="submit" class="btn">Filter</button>
</form>

{#if rows.length === 0}
  <p class="mt-8 text-fg/70">
    {filters.q
      ? 'No jobs match that search.'
      : filters.status === 'closed'
        ? 'No closed jobs.'
        : 'No open jobs.'}
  </p>
{:else}
  <ul class="mt-6 divide-y divide-fg/10 rounded-sm border border-fg/10 bg-surface-2">
    {#each rows as job (job.id)}
      <li>
        <a
          href="/jobs/{job.id}"
          class="flex items-center justify-between gap-4 px-5 py-4 transition-colors hover:opacity-70"
        >
          <span class="min-w-0 flex-1">
            <span class="font-serif text-lg text-fg">{job.name}</span>
            {#if job.contactName}
              <span class="ml-2 text-sm text-fg/50">{job.contactName}</span>
            {/if}
            {#if job.status === 'closed'}
              <span
                class="ml-2 rounded-sm border border-fg/15 px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-widest text-fg/50"
              >
                Closed
              </span>
            {/if}
          </span>
          <!--
            What this job could invoice right now. Gold only when there is
            something, so the column reads as a prompt rather than a data dump.
            The unrated case gets its own words: $0.00 beside a day of unpriced
            work would read as "nothing to bill" when there is plenty.
          -->
          <span class="shrink-0 text-right">
            {#if Number(job.readyToBill) > 0}
              <span class="font-mono tabular-nums text-accent">{fmt(job.readyToBill)} ready</span>
            {:else if job.unratedMinutes > 0}
              <span class="label">needs a rate</span>
            {:else}
              <span class="label">{dateRange(job.startedOn, job.endedOn)}</span>
            {/if}
          </span>
        </a>
      </li>
    {/each}
  </ul>
  <LoadMore hasMore={cursor !== null} {loading} error={loadError} onclick={more} />
{/if}

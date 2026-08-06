<script lang="ts">
  import LoadMore from '$lib/components/LoadMore.svelte';
  import { fetchMore } from '$lib/load-more';
  import { may } from '$lib/perms';
  import { untrack } from 'svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  const showClosed = $derived(data.showClosed);

  // Same untrack() seed-and-re-seed pattern as /items and /contacts: load()
  // re-runs on the closed-toggle nav, and the $effect keeps the list in sync.
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
        closed: showClosed ? '1' : '',
      });
      rows = [...rows, ...page.rows];
      cursor = page.nextCursor;
    } catch {
      loadError = true;
    } finally {
      loading = false;
    }
  }

  const fmt = (s: string) =>
    Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

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
      The work<span class="text-accent">.</span>
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

<div class="mt-6">
  <a href={showClosed ? '/jobs' : '/jobs?closed=1'} class="label hover:text-accent">
    {showClosed ? '← Open jobs only' : 'Show closed'}
  </a>
</div>

{#if rows.length === 0}
  <p class="mt-8 text-fg/70">
    {showClosed ? 'No jobs yet.' : 'No open jobs.'}
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
              <span class="font-mono tabular-nums text-accent">
                {fmt(job.readyToBill)} ready
              </span>
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

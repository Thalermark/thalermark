<script lang="ts">
  import AuditHistory from '$lib/components/AuditHistory.svelte';
  import LoadMore from '$lib/components/LoadMore.svelte';
  import { fetchMore } from '$lib/load-more';
  import { untrack } from 'svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  // See /contacts for the untrack() seed-and-re-seed pattern.
  type Event = (typeof data.events)[number];
  let events = $state<Event[]>(untrack(() => data.events));
  let cursor = $state<string | null>(untrack(() => data.nextCursor));
  let loading = $state(false);
  let loadError = $state(false);

  $effect(() => {
    const nextEvents = data.events;
    const next = data.nextCursor;
    untrack(() => {
      events = nextEvents;
      cursor = next;
    });
  });

  async function more() {
    if (loading || cursor === null) return;
    loading = true;
    loadError = false;
    try {
      const page = await fetchMore<Event>('/settings/activity/more', cursor);
      events = [...events, ...page.rows];
      cursor = page.nextCursor;
    } catch {
      loadError = true;
    } finally {
      loading = false;
    }
  }
</script>

<h1 class="font-serif text-4xl font-light leading-none tracking-tight text-fg">
  Activity<span class="text-accent">.</span>
</h1>
<p class="mt-3 text-sm text-fg/60">Recent changes across your workspace. Newest first.</p>

<AuditHistory {events} showEntity />
<LoadMore hasMore={cursor !== null} {loading} error={loadError} onclick={more} />

<script lang="ts">
  import AuditHistory from '$lib/components/AuditHistory.svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
</script>

<h1 class="font-serif text-4xl font-light leading-none tracking-tight text-ink">
  Activity<span class="text-gold-deep">.</span>
</h1>
<p class="mt-3 text-sm text-ink/60">
  Recent changes across your account. Newest first; up to the last 100 events.
</p>

<AuditHistory events={data.events} showEntity />

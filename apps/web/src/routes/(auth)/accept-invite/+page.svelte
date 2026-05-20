<script lang="ts">
  import { page } from '$app/state';

  const token = $derived(page.url.searchParams.get('token'));
</script>

<h2 class="mb-4 text-lg font-medium text-primary-900">Accept invite</h2>
<p class="text-sm text-primary-600">
  {#if token}
    Token: <code class="rounded bg-primary-100 px-1 py-0.5 text-primary-900">{token}</code>
  {:else}
    No invite token in the URL.
  {/if}
</p>
<p class="mt-4 text-sm text-primary-500">
  The full accept-invite flow ships in slice 5.4.
</p>

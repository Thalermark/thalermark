<script lang="ts">
  import { page } from '$app/state';
  import { TAGLINE } from '@thalermark/brand';

  const session = page.data.session;
</script>

<h1 class="text-2xl font-semibold text-primary-900">Welcome back</h1>
<p class="mt-1 text-primary-600">{TAGLINE}</p>
{#if session}
  <p class="mt-4 text-sm text-primary-500">Signed in as {session.user.email}.</p>
{/if}

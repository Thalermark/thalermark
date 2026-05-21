<script lang="ts">
  import { page } from '$app/state';
  import { TAGLINE } from '@thalermark/brand';

  const session = page.data.session;
</script>

<span class="eyebrow">Dashboard</span>
<h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-ink">
  Welcome back<span class="text-gold-deep">.</span>
</h1>
<p class="mt-4 max-w-xl text-ink/70">{TAGLINE}</p>
{#if session}
  <p class="mt-6 font-mono text-xs uppercase tracking-widest text-ink/50">
    Signed in as {session.user.email}
  </p>
{/if}

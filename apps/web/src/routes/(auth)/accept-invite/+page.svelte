<script lang="ts">
  import { onMount } from 'svelte';
  import { env } from '$env/dynamic/public';
  import { page } from '$app/state';

  type Status = 'idle' | 'submitting' | 'error' | 'success';

  const apiUrl = env.PUBLIC_API_URL ?? 'http://localhost:3000';
  const token = $derived(page.url.searchParams.get('token'));
  const session = $derived(page.data.session);

  let status = $state<Status>('idle');
  let errorMsg = $state<string | null>(null);

  async function accept() {
    if (!token) return;
    status = 'submitting';
    errorMsg = null;
    try {
      const res = await fetch(`${apiUrl}/api/invitations/${token}/accept`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        errorMsg = body.error ?? `accept failed (${res.status})`;
        status = 'error';
        return;
      }
      status = 'success';
      window.location.assign('/');
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : 'network error';
      status = 'error';
    }
  }

  onMount(() => {
    if (token && session) accept();
  });
</script>

<span class="eyebrow">Invitation</span>
<h1 class="mt-3 font-serif text-3xl font-light leading-tight tracking-tight text-ink">
  Accept invite
</h1>

<div class="mt-6 text-sm text-ink/75">
  {#if !token}
    <p>No invite token in the URL.</p>
  {:else if !session}
    <p>Sign in or create an account to accept this invitation.</p>
    <div class="mt-6 flex flex-col gap-3">
      <a
        href="/sign-in?invite={token}"
        class="w-full rounded-sm bg-ink px-3 py-3 text-center text-sm font-medium text-cream transition-colors hover:bg-gold-deep"
      >
        Sign in
      </a>
      <a
        href="/sign-up?invite={token}"
        class="w-full rounded-sm border border-ink/30 px-3 py-3 text-center text-sm font-medium text-ink transition-colors hover:border-ink"
      >
        Create account
      </a>
    </div>
  {:else if status === 'submitting' || status === 'idle'}
    <p class="font-mono text-xs uppercase tracking-widest text-ink/60">Accepting invitation…</p>
  {:else if status === 'error'}
    <p class="font-mono text-xs uppercase tracking-widest text-oxblood">
      {errorMsg ?? 'Something went wrong.'}
    </p>
    <button
      type="button"
      onclick={accept}
      class="mt-6 w-full rounded-sm bg-ink px-3 py-3 text-sm font-medium text-cream transition-colors hover:bg-gold-deep"
    >
      Try again
    </button>
  {:else if status === 'success'}
    <p class="font-mono text-xs uppercase tracking-widest text-ink/60">
      Invitation accepted. Redirecting…
    </p>
  {/if}
</div>

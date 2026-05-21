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

<h2 class="mb-4 text-lg font-medium text-primary-900">Accept invite</h2>

{#if !token}
  <p class="text-sm text-primary-600">No invite token in the URL.</p>
{:else if !session}
  <p class="text-sm text-primary-600">
    Sign in or create an account to accept this invitation.
  </p>
  <div class="mt-4 flex flex-col gap-2">
    <a
      href="/sign-in?invite={token}"
      class="w-full rounded bg-primary-900 px-3 py-2 text-center text-white"
    >
      Sign in
    </a>
    <a
      href="/sign-up?invite={token}"
      class="w-full rounded border border-primary-300 px-3 py-2 text-center text-primary-900"
    >
      Create account
    </a>
  </div>
{:else if status === 'submitting' || status === 'idle'}
  <p class="text-sm text-primary-600">Accepting invitation…</p>
{:else if status === 'error'}
  <p class="text-sm text-red-600">{errorMsg ?? 'Something went wrong.'}</p>
  <button
    type="button"
    onclick={accept}
    class="mt-4 w-full rounded bg-primary-900 px-3 py-2 text-white"
  >
    Try again
  </button>
{:else if status === 'success'}
  <p class="text-sm text-primary-600">Invitation accepted. Redirecting…</p>
{/if}

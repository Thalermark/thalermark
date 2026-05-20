<script lang="ts">
  import { authClient } from '$lib/auth-client';
  import { COPY } from '@thalermark/brand';

  let email = $state('');
  let password = $state('');
  let error = $state<string | null>(null);
  let submitting = $state(false);

  async function onSubmit(event: SubmitEvent) {
    event.preventDefault();
    error = null;
    submitting = true;
    const result = await authClient.signIn.email({ email, password });
    submitting = false;
    if (result.error) {
      error = result.error.message ?? 'Sign-in failed';
      return;
    }
    // Hard nav: forces hooks.server.ts to re-run membership routing on a
    // fresh request. goto() + invalidateAll() leaves stale layout data.
    window.location.assign('/');
  }
</script>

<h2 class="mb-4 text-lg font-medium text-primary-900">{COPY.signIn.title}</h2>

<form onsubmit={onSubmit} class="space-y-4">
  <label class="block">
    <span class="block text-sm text-primary-700">Email</span>
    <input
      type="email"
      required
      bind:value={email}
      class="mt-1 w-full rounded border border-primary-300 px-3 py-2"
    />
  </label>
  <label class="block">
    <span class="block text-sm text-primary-700">Password</span>
    <input
      type="password"
      required
      bind:value={password}
      class="mt-1 w-full rounded border border-primary-300 px-3 py-2"
    />
  </label>
  {#if error}
    <p class="text-sm text-red-600">{error}</p>
  {/if}
  <button
    type="submit"
    disabled={submitting}
    class="w-full rounded bg-primary-900 px-3 py-2 text-white disabled:opacity-50"
  >
    {COPY.signIn.submit}
  </button>
</form>

<p class="mt-4 text-center text-sm text-primary-600">
  No account? <a href="/sign-up" class="underline">Sign up</a>
</p>

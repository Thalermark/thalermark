<script lang="ts">
  import { authClient } from '$lib/auth-client';
  import { goto } from '$app/navigation';
  import { COPY } from '@thalermark/brand';

  let name = $state('');
  let email = $state('');
  let password = $state('');
  let error = $state<string | null>(null);
  let submitting = $state(false);

  async function onSubmit(event: SubmitEvent) {
    event.preventDefault();
    error = null;
    submitting = true;
    const result = await authClient.signUp.email({ email, password, name });
    submitting = false;
    if (result.error) {
      error = result.error.message ?? 'Sign-up failed';
      return;
    }
    await goto('/');
  }
</script>

<h2 class="mb-4 text-lg font-medium text-primary-900">{COPY.signUp.title}</h2>

<form onsubmit={onSubmit} class="space-y-4">
  <label class="block">
    <span class="block text-sm text-primary-700">Name</span>
    <input
      type="text"
      required
      bind:value={name}
      class="mt-1 w-full rounded border border-primary-300 px-3 py-2"
    />
  </label>
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
      minlength={8}
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
    {COPY.signUp.submit}
  </button>
</form>

<p class="mt-4 text-center text-sm text-primary-600">
  Already have an account? <a href="/sign-in" class="underline">Sign in</a>
</p>

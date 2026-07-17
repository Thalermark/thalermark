<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { authClient } from '$lib/auth-client';
  import * as Sentry from '@sentry/sveltekit';

  // The api emails a link to `${PUBLIC_APP_URL}/reset-password?token=…`. If Better
  // Auth's GET hop is ever used instead, an expired/used token arrives as
  // `?error=INVALID_TOKEN` — surface the same dead-link state for either.
  const token = $derived(page.url.searchParams.get('token'));
  const linkError = $derived(page.url.searchParams.get('error'));

  let password = $state('');
  let confirm = $state('');
  let error = $state<string | null>(null);
  let submitting = $state(false);
  let done = $state(false);

  async function onSubmit(event: SubmitEvent) {
    event.preventDefault();
    error = null;
    if (!token) {
      error = 'This reset link is invalid or has expired.';
      return;
    }
    if (password !== confirm) {
      error = 'Passwords do not match.';
      return;
    }
    submitting = true;
    try {
      const result = await authClient.resetPassword({ newPassword: password, token });
      if (result.error) {
        error =
          result.error.code === 'INVALID_TOKEN'
            ? 'This reset link has expired — request a new one.'
            : (result.error.message ?? 'Could not reset your password.');
        return;
      }
      // A completed reset revokes existing sessions, so send them to sign in fresh.
      done = true;
      setTimeout(() => goto('/sign-in'), 1500);
    } catch (e) {
      Sentry.captureException(e); // report the transport failure (TMCLD-100)
      error = 'Could not reach the server. Check your connection and try again.';
    } finally {
      submitting = false;
    }
  }
</script>

<span class="eyebrow">Account recovery</span>
<h1 class="mt-3 font-serif text-3xl font-light leading-tight tracking-tight text-fg">
  Choose a new password
</h1>

{#if done}
  <div class="callout mt-8 px-5 py-4">
    <p class="font-serif text-lg text-fg">Password updated.</p>
    <p class="mt-2 text-sm text-fg/75">Taking you to sign in…</p>
  </div>
{:else if !token || linkError}
  <div class="mt-8 rounded-sm border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
    This reset link is invalid or has expired.
    <a href="/forgot-password" class="link">Request a new one.</a>
  </div>
{:else}
  <form onsubmit={onSubmit} class="mt-8 space-y-5">
    <label class="block">
      <span class="label block">New password</span>
      <input
        type="password"
        required
        minlength={8}
        autocomplete="new-password"
        bind:value={password}
        class="field-line mt-2"
      />
    </label>
    <label class="block">
      <span class="label block">Confirm new password</span>
      <input
        type="password"
        required
        minlength={8}
        autocomplete="new-password"
        bind:value={confirm}
        class="field-line mt-2"
      />
    </label>
    {#if error}
      <p class="label text-danger">{error}</p>
    {/if}
    <button type="submit" disabled={submitting} class="btn w-full py-3">
      {submitting ? 'Updating…' : 'Update password'}
    </button>
  </form>
{/if}

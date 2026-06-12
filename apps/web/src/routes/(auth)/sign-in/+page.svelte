<script lang="ts">
  import { page } from '$app/state';
  import { authClient } from '$lib/auth-client';
  import SocialSignIn from '$lib/components/SocialSignIn.svelte';
  import { COPY } from '@thalermark/brand';

  let email = $state('');
  let password = $state('');
  let error = $state<string | null>(null);
  let submitting = $state(false);

  const inviteToken = $derived(page.url.searchParams.get('invite'));
  const postAuthPath = $derived(
    inviteToken ? `/accept-invite?token=${encodeURIComponent(inviteToken)}` : '/',
  );
  const signUpHref = $derived(inviteToken ? `/sign-up?invite=${encodeURIComponent(inviteToken)}` : '/sign-up');

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
    window.location.assign(postAuthPath);
  }
</script>

<span class="eyebrow">Welcome back</span>
<h1 class="mt-3 font-serif text-3xl font-light leading-tight tracking-tight text-ink">
  {COPY.signIn.title}
</h1>

<form onsubmit={onSubmit} class="mt-8 space-y-5">
  <label class="block">
    <span class="block font-mono text-xs uppercase tracking-widest text-ink/60">Email</span>
    <input
      type="email"
      required
      bind:value={email}
      class="mt-2 w-full border-b border-ink/30 bg-transparent py-2 text-ink outline-none focus:border-ink"
    />
  </label>
  <label class="block">
    <span class="block font-mono text-xs uppercase tracking-widest text-ink/60">Password</span>
    <input
      type="password"
      required
      bind:value={password}
      class="mt-2 w-full border-b border-ink/30 bg-transparent py-2 text-ink outline-none focus:border-ink"
    />
  </label>
  {#if error}
    <p class="font-mono text-xs uppercase tracking-widest text-oxblood">{error}</p>
  {/if}
  <button
    type="submit"
    disabled={submitting}
    class="w-full rounded-sm bg-ink px-3 py-3 text-sm font-medium text-cream transition-colors hover:bg-gold-deep disabled:opacity-50"
  >
    {COPY.signIn.submit}
  </button>
</form>

<!-- Hidden during an invite flow: invites are email-anchored, so a mismatched
     social account would create a stray account instead of joining. -->
<SocialSignIn
  providers={inviteToken ? [] : (page.data.socialProviders ?? [])}
  callbackPath={postAuthPath}
/>

<p class="mt-8 text-center text-sm text-ink/70">
  No account?
  <a
    href={signUpHref}
    class="border-b border-gold-deep text-gold-deep transition-colors hover:border-ink hover:text-ink"
    >Sign up</a
  >
</p>

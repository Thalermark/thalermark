<script lang="ts">
  import { page } from '$app/state';
  import { authClient } from '$lib/auth-client';
  import { COPY } from '@thalermark/brand';

  let name = $state('');
  let email = $state('');
  let password = $state('');
  let error = $state<string | null>(null);
  let submitting = $state(false);

  const inviteToken = $derived(page.url.searchParams.get('invite'));
  const postAuthPath = $derived(
    inviteToken ? `/accept-invite?token=${encodeURIComponent(inviteToken)}` : '/',
  );
  const signInHref = $derived(inviteToken ? `/sign-in?invite=${encodeURIComponent(inviteToken)}` : '/sign-in');

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
    // Hard nav: forces hooks.server.ts to re-run on a fresh request so the
    // new session + membership routing applies. See sign-in for context.
    window.location.assign(postAuthPath);
  }
</script>

<span class="eyebrow">Get early access</span>
<h1 class="mt-3 font-serif text-3xl font-light leading-tight tracking-tight text-ink">
  {COPY.signUp.title}
</h1>

<form onsubmit={onSubmit} class="mt-8 space-y-5">
  <label class="block">
    <span class="block font-mono text-xs uppercase tracking-widest text-ink/60">Name</span>
    <input
      type="text"
      required
      bind:value={name}
      class="mt-2 w-full border-b border-ink/30 bg-transparent py-2 text-ink outline-none focus:border-ink"
    />
  </label>
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
      minlength={8}
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
    {COPY.signUp.submit}
  </button>
</form>

<p class="mt-8 text-center text-sm text-ink/70">
  Already have an account?
  <a
    href={signInHref}
    class="border-b border-gold-deep text-gold-deep transition-colors hover:border-ink hover:text-ink"
    >Sign in</a
  >
</p>

<script lang="ts">
  import { onMount } from 'svelte';
  import { env } from '$env/dynamic/public';
  import { page } from '$app/state';
  import { authClient } from '$lib/auth-client';
  import { COPY } from '@thalermark/brand';

  const apiUrl = env.PUBLIC_API_URL ?? 'http://localhost:3000';
  const inviteToken = $derived(page.url.searchParams.get('invite'));

  let name = $state('');
  let email = $state('');
  let password = $state('');
  let error = $state<string | null>(null);
  let submitting = $state(false);

  // Invite preview. When arriving via an invite link, the email is fixed to the
  // invited address — the sign-up hook joins the inviting account by matching it
  // — so we prefill + lock it; the only thing the invitee fills in is their name
  // and a password. The hook then joins them (no personal company seeded), so a
  // successful invited signup goes straight to the app.
  type Invite = {
    email: string;
    accountName: string;
    inviterName: string | null;
    expired: boolean;
    accepted: boolean;
  };
  let invite = $state<Invite | null>(null);
  let inviteStale = $state(false); // expired / already accepted / not found

  onMount(async () => {
    if (!inviteToken) return;
    try {
      const res = await fetch(`${apiUrl}/api/invitations/${inviteToken}`);
      if (!res.ok) {
        inviteStale = true;
        return;
      }
      const body = (await res.json()) as Invite;
      if (body.expired || body.accepted) {
        inviteStale = true;
        return;
      }
      invite = body;
      email = body.email;
    } catch {
      inviteStale = true;
    }
  });

  const signInHref = $derived(
    inviteToken ? `/sign-in?invite=${encodeURIComponent(inviteToken)}` : '/sign-in',
  );

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
    // Hard nav so hooks.server.ts re-runs on a fresh request (new session +
    // membership routing). An invited signup was already joined to the inviting
    // account by the hook; a fresh signup got its own seeded company.
    window.location.assign('/');
  }
</script>

<span class="eyebrow">{invite ? 'Accept invitation' : 'Get early access'}</span>
<h1 class="mt-3 font-serif text-3xl font-light leading-tight tracking-tight text-ink">
  {COPY.signUp.title}
</h1>

{#if invite}
  <p class="mt-4 rounded-sm border border-gold-deep/30 bg-gold-deep/5 px-4 py-3 text-sm text-ink/80">
    {#if invite.inviterName}<span class="font-medium">{invite.inviterName}</span> invited you to join
    {:else}You've been invited to join{/if}
    <span class="font-medium">{invite.accountName}</span>. Set a password below to join their
    workspace.
  </p>
{:else if inviteStale}
  <p class="mt-4 rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-3 text-sm text-oxblood">
    That invitation link is no longer valid. You can still create your own account below.
  </p>
{/if}

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
      readonly={!!invite}
      bind:value={email}
      class="mt-2 w-full border-b border-ink/30 bg-transparent py-2 text-ink outline-none focus:border-ink {invite
        ? 'cursor-not-allowed text-ink/60'
        : ''}"
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
    {invite ? 'Join workspace' : COPY.signUp.submit}
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

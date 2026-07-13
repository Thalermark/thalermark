<script lang="ts">
  import { onMount } from 'svelte';
  import { env } from '$env/dynamic/public';
  import { page } from '$app/state';
  import { authClient } from '$lib/auth-client';

  // The email-link entry point. Reworked from auto-firing accept on mount to an
  // explicit prompt: show who's inviting + which workspace, then Accept /
  // Decline. The in-app path (dashboard notice → Workspace screen banners)
  // covers signed-in users; this covers the link in the invite email.
  type Preview = {
    email: string;
    accountName: string;
    inviterName: string | null;
    expired: boolean;
    accepted: boolean;
  };
  type Status = 'loading' | 'ready' | 'invalid' | 'working' | 'declined' | 'error';

  const apiUrl = env.PUBLIC_API_URL ?? 'http://localhost:3000';
  const token = $derived(page.url.searchParams.get('token'));
  const session = $derived(page.data.session);

  let status = $state<Status>('loading');
  let preview = $state<Preview | null>(null);
  let errorMsg = $state<string | null>(null);
  let errorCode = $state<string | null>(null);
  let signingOut = $state(false);

  onMount(async () => {
    if (!token) {
      status = 'invalid';
      return;
    }
    try {
      const res = await fetch(`${apiUrl}/api/invitations/${token}`);
      if (!res.ok) {
        status = 'invalid';
        return;
      }
      const body = (await res.json()) as Preview;
      if (body.expired || body.accepted) {
        status = 'invalid';
        return;
      }
      preview = body;
      status = 'ready';
    } catch {
      status = 'invalid';
    }
  });

  // Map an API error code to a clear, actionable message. The mismatch case is
  // the common one — the link was opened while signed in as someone else — so it
  // names both addresses and points at signing out, instead of showing the raw
  // code or blaming the invite.
  function friendlyError(code: string | undefined, currentEmail: string | null): string {
    switch (code) {
      case 'invite_email_mismatch':
        return `This invitation was sent to ${preview?.email ?? 'a different email address'}${
          currentEmail ? `, but you're signed in as ${currentEmail}` : ''
        }. Sign out and open this link again to accept it.`;
      case 'invite_not_found':
        return 'That invitation is no longer valid.';
      case 'invite_expired':
        return 'That invitation has expired.';
      case 'invite_already_accepted':
        return "You've already accepted that invitation.";
      case 'unauthorized':
        return 'Please sign in to respond to this invitation.';
      default:
        return 'Something went wrong. Please try again.';
    }
  }

  async function respond(decision: 'accept' | 'decline') {
    if (!token) return;
    status = 'working';
    errorMsg = null;
    errorCode = null;
    try {
      const res = await fetch(`${apiUrl}/api/invitations/${token}/${decision}`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          currentEmail?: string;
        };
        errorCode = body.error ?? null;
        errorMsg = friendlyError(body.error, body.currentEmail ?? null);
        status = 'error';
        return;
      }
      if (decision === 'accept') {
        // Joined — land in the app; hooks.server.ts re-resolves the session.
        window.location.assign('/');
      } else {
        status = 'declined';
      }
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : 'network error';
      status = 'error';
    }
  }

  // Sign out, then reload as a signed-out visitor so the page falls back to the
  // sign-in / create-account prompt for this same invite token.
  async function signOutAndRetry() {
    signingOut = true;
    try {
      await authClient.signOut();
    } finally {
      window.location.reload();
    }
  }
</script>

<span class="eyebrow">Invitation</span>
<h1 class="mt-3 font-serif text-3xl font-light leading-tight tracking-tight text-fg">
  Workspace invite
</h1>

<div class="mt-6 text-sm text-fg/75">
  {#if !token || status === 'invalid'}
    <p>That invitation link is no longer valid.</p>
  {:else if !session}
    <p>Sign in or create an account to respond to this invitation.</p>
    <div class="mt-6 flex flex-col gap-3">
      <a href="/sign-in?invite={token}" class="btn w-full py-3"> Sign in </a>
      <a href="/sign-up?invite={token}" class="btn-ghost w-full py-3"> Create account </a>
    </div>
  {:else if status === 'loading'}
    <p class="label">Loading invitation…</p>
  {:else if status === 'declined'}
    <p>You've declined this invitation.</p>
    <a href="/" class="link mt-6 inline-block">Go to Thalermark</a>
  {:else if status === 'ready' || status === 'working' || status === 'error'}
    {#if preview}
      <p>
        {#if preview.inviterName}<span class="font-medium">{preview.inviterName}</span> invited you to
          join
        {:else}You've been invited to join{/if}
        <span class="font-medium">{preview.accountName}</span>.
      </p>
    {/if}
    {#if status === 'error'}
      <p class="label mt-4 text-danger">
        {errorMsg ?? 'Something went wrong.'}
      </p>
      {#if errorCode === 'invite_email_mismatch'}
        <button
          type="button"
          disabled={signingOut}
          onclick={signOutAndRetry}
          class="btn mt-4 py-2.5"
        >
          {signingOut ? 'Signing out…' : 'Sign out'}
        </button>
      {/if}
    {/if}
    <div class="mt-6 flex items-center gap-3">
      <button
        type="button"
        disabled={status === 'working'}
        onclick={() => respond('accept')}
        class="btn py-2.5"
      >
        Accept
      </button>
      <button
        type="button"
        disabled={status === 'working'}
        onclick={() => respond('decline')}
        class="btn-ghost py-2.5"
      >
        Decline
      </button>
    </div>
  {/if}
</div>

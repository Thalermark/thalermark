<script lang="ts">
  import { onMount } from 'svelte';
  import { env } from '$env/dynamic/public';
  import { page } from '$app/state';

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

  async function respond(decision: 'accept' | 'decline') {
    if (!token) return;
    status = 'working';
    errorMsg = null;
    try {
      const res = await fetch(`${apiUrl}/api/invitations/${token}/${decision}`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        errorMsg = body.error ?? `Request failed (${res.status})`;
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
</script>

<span class="eyebrow">Invitation</span>
<h1 class="mt-3 font-serif text-3xl font-light leading-tight tracking-tight text-ink">
  Workspace invite
</h1>

<div class="mt-6 text-sm text-ink/75">
  {#if !token || status === 'invalid'}
    <p>That invitation link is no longer valid.</p>
  {:else if !session}
    <p>Sign in or create an account to respond to this invitation.</p>
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
  {:else if status === 'loading'}
    <p class="font-mono text-xs uppercase tracking-widest text-ink/60">Loading invitation…</p>
  {:else if status === 'declined'}
    <p>You've declined this invitation.</p>
    <a
      href="/"
      class="mt-6 inline-block border-b border-gold-deep text-gold-deep transition-colors hover:border-ink hover:text-ink"
      >Go to Thalermark</a
    >
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
      <p class="mt-4 font-mono text-xs uppercase tracking-widest text-oxblood">
        {errorMsg ?? 'Something went wrong.'}
      </p>
    {/if}
    <div class="mt-6 flex items-center gap-3">
      <button
        type="button"
        disabled={status === 'working'}
        onclick={() => respond('accept')}
        class="rounded-sm bg-ink px-4 py-2.5 text-sm font-medium text-cream transition-colors hover:bg-gold-deep disabled:opacity-50"
      >
        Accept
      </button>
      <button
        type="button"
        disabled={status === 'working'}
        onclick={() => respond('decline')}
        class="rounded-sm border border-ink/30 px-4 py-2.5 text-sm font-medium text-ink transition-colors hover:border-ink disabled:opacity-50"
      >
        Decline
      </button>
    </div>
  {/if}
</div>

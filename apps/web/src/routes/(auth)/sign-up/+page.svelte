<script lang="ts">
  import { onMount } from 'svelte';
  import { env } from '$env/dynamic/public';
  import { page } from '$app/state';
  import { authClient } from '$lib/auth-client';
  import SocialSignIn from '$lib/components/SocialSignIn.svelte';
  import PasswordStrength from '$lib/components/PasswordStrength.svelte';
  import { COPY } from '@thalermark/brand';
  import { checkPassword } from '@thalermark/validation';

  const apiUrl = env.PUBLIC_API_URL ?? 'http://localhost:3000';
  const inviteToken = $derived(page.url.searchParams.get('invite'));

  let name = $state('');
  let email = $state('');
  let password = $state('');
  let error = $state<string | null>(null);
  let submitting = $state(false);
  let awaitingVerification = $state(false);
  let resending = $state(false);
  let resent = $state(false);

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
    const pwCheck = checkPassword(password);
    if (!pwCheck.ok) {
      error = pwCheck.message;
      return;
    }
    submitting = true;
    const result = await authClient.signUp.email({
      email,
      password,
      name,
      callbackURL: `${window.location.origin}/`,
    });
    submitting = false;
    if (result.error) {
      error = result.error.message ?? 'Sign-up failed';
      return;
    }
    // Invited signups are auto-verified (the invite already proves email
    // ownership). And when email verification isn't required (no mailer
    // configured), Better Auth signs the user in immediately and returns a
    // session token. In both cases we hard-nav into the app. Only when the
    // server withholds the session pending verification (no token) do we show
    // the check-your-inbox state.
    if (inviteToken || result.data?.token) {
      window.location.assign('/');
    } else {
      awaitingVerification = true;
    }
  }

  async function onResend() {
    resending = true;
    resent = false;
    await authClient.sendVerificationEmail({ email, callbackURL: `${window.location.origin}/` });
    resending = false;
    resent = true;
  }
</script>

<span class="eyebrow">{invite ? 'Accept invitation' : 'Get early access'}</span>
<h1 class="mt-3 font-serif text-3xl font-light leading-tight tracking-tight text-fg">
  {COPY.signUp.title}
</h1>

{#if invite}
  <p class="callout mt-4">
    {#if invite.inviterName}<span class="font-medium">{invite.inviterName}</span> invited you to join
    {:else}You've been invited to join{/if}
    <span class="font-medium">{invite.accountName}</span>. Set a password below to join their
    workspace.
  </p>
{:else if inviteStale}
  <p class="mt-4 rounded-sm border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
    That invitation link is no longer valid. You can still create your own account below.
  </p>
{/if}

{#if awaitingVerification}
  <div class="callout mt-8 px-5 py-4">
    <p class="font-serif text-lg text-fg">Check your inbox.</p>
    <p class="mt-2 text-sm text-fg/75">
      We sent a verification link to <span class="font-medium text-fg">{email}</span>. Click it to
      finish setting up your account — you'll be signed in automatically.
    </p>
    <div class="mt-4 flex items-center gap-4">
      <button type="button" onclick={onResend} disabled={resending} class="btn-ghost">
        {resending ? 'Sending…' : 'Resend email'}
      </button>
      {#if resent}
        <span class="label text-success">Sent</span>
      {/if}
    </div>
  </div>
{:else}
<form onsubmit={onSubmit} class="mt-8 space-y-5">
  <label class="block">
    <span class="label block">Name</span>
    <input type="text" required bind:value={name} class="field-line mt-2" />
  </label>
  <label class="block">
    <span class="label block">Email</span>
    <input
      type="email"
      required
      readonly={!!invite}
      bind:value={email}
      class="field-line mt-2 {invite ? 'cursor-not-allowed text-fg/60' : ''}"
    />
  </label>
  <label class="block">
    <span class="label block">Password</span>
    <input type="password" required minlength={10} bind:value={password} class="field-line mt-2" />
    <PasswordStrength {password} />
  </label>
  {#if error}
    <p class="label text-danger">{error}</p>
  {/if}
  <button type="submit" disabled={submitting} class="btn w-full py-3">
    {invite ? 'Join workspace' : COPY.signUp.submit}
  </button>
</form>

<!-- Hidden during an invite flow: invites are email-anchored, so a mismatched
     social account would create a stray account instead of joining. -->
<SocialSignIn
  providers={inviteToken ? [] : (page.data.socialProviders ?? [])}
  callbackPath="/"
  lastUsed={inviteToken ? null : (page.data.lastAuthMethod ?? null)}
/>

<p class="mt-8 text-center text-sm text-fg/70">
  Already have an account?
  <a href={signInHref} class="link">Sign in</a>
</p>
{/if}

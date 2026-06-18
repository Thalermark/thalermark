<script lang="ts">
  import { page } from '$app/state';
  import { authClient } from '$lib/auth-client';
  import SocialSignIn from '$lib/components/SocialSignIn.svelte';
  import { COPY } from '@thalermark/brand';

  let email = $state('');
  let password = $state('');
  let error = $state<string | null>(null);
  let submitting = $state(false);
  let needsVerification = $state(false);
  let resending = $state(false);
  let resent = $state(false);

  const inviteToken = $derived(page.url.searchParams.get('invite'));
  const postAuthPath = $derived(
    inviteToken ? `/accept-invite?token=${encodeURIComponent(inviteToken)}` : '/',
  );
  const signUpHref = $derived(inviteToken ? `/sign-up?invite=${encodeURIComponent(inviteToken)}` : '/sign-up');

  // Social providers the api advertises (already public via the rendered
  // buttons) + this device's last-used method (a local, leak-free cookie read
  // server-side in the (auth) load).
  const socialProviders = $derived((page.data.socialProviders ?? []) as string[]);
  const lastAuthMethod = $derived((page.data.lastAuthMethod ?? null) as string | null);

  const PROVIDER_LABELS: Record<string, string> = {
    google: 'Google',
    facebook: 'Facebook',
    twitter: 'X',
  };

  // Option B wrong-method rescue: on ANY failed login, nudge users who signed up
  // with a social provider toward the buttons below. Deliberately UNCONDITIONAL
  // w.r.t. the entered email (no email→provider lookup) so it can't leak whether
  // an account exists or which provider it uses. Hidden when no social providers
  // are configured, and suppressed when this device last signed in with a
  // password (a device-local signal that leaks nothing remotely).
  const showMethodHint = $derived(
    !!error && socialProviders.length > 0 && lastAuthMethod !== 'password',
  );
  const methodHintText = $derived(joinOr(socialProviders.map((p) => PROVIDER_LABELS[p] ?? p)));

  // Oxford-style "A, B, or C".
  function joinOr(names: string[]): string {
    if (names.length <= 1) return names[0] ?? '';
    if (names.length === 2) return `${names[0]} or ${names[1]}`;
    return `${names.slice(0, -1).join(', ')}, or ${names.at(-1)}`;
  }

  // Remember this device's last sign-in method (provider id or 'password') so the
  // next visit can badge the right button and suppress the wrong-method hint.
  // Only the method string is stored — nothing identifying. Read back
  // server-side in the (auth) layout load.
  function rememberMethod(method: string) {
    document.cookie = `last_auth_method=${method}; path=/; max-age=31536000; samesite=lax`;
  }

  async function onSubmit(event: SubmitEvent) {
    event.preventDefault();
    error = null;
    submitting = true;
    needsVerification = false;
    const result = await authClient.signIn.email({ email, password });
    submitting = false;
    if (result.error) {
      const msg = result.error.message ?? 'Sign-in failed';
      // Unverified email/password account → offer to resend the link instead of
      // a dead-end error. BA returns EMAIL_NOT_VERIFIED; match the message too
      // in case the code shape shifts.
      if (result.error.code === 'EMAIL_NOT_VERIFIED' || /verif/i.test(msg)) {
        needsVerification = true;
        return;
      }
      error = msg;
      return;
    }
    rememberMethod('password');
    // Hard nav: forces hooks.server.ts to re-run membership routing on a
    // fresh request. goto() + invalidateAll() leaves stale layout data.
    window.location.assign(postAuthPath);
  }

  async function onResend() {
    resending = true;
    resent = false;
    await authClient.sendVerificationEmail({
      email,
      callbackURL: `${window.location.origin}${postAuthPath}`,
    });
    resending = false;
    resent = true;
  }
</script>

<span class="eyebrow">Welcome back</span>
<h1 class="mt-3 font-serif text-3xl font-light leading-tight tracking-tight text-fg">
  {COPY.signIn.title}
</h1>

<form onsubmit={onSubmit} class="mt-8 space-y-5">
  <label class="block">
    <span class="label block">Email</span>
    <input type="email" required bind:value={email} class="field-line mt-2" />
  </label>
  <label class="block">
    <span class="label block">Password</span>
    <input type="password" required bind:value={password} class="field-line mt-2" />
  </label>
  {#if error}
    <p class="label text-danger">{error}</p>
    {#if showMethodHint}
      <p class="text-sm text-fg/60">
        Signed up with {methodHintText}? Use the button{socialProviders.length > 1 ? 's' : ''} below.
      </p>
    {/if}
  {/if}
  {#if needsVerification}
    <div class="callout">
      <p>
        Verify your email to sign in — we sent a link to
        <span class="font-medium text-fg">{email}</span>.
      </p>
      <div class="mt-3 flex items-center gap-4">
        <button type="button" onclick={onResend} disabled={resending} class="btn-ghost btn-sm">
          {resending ? 'Sending…' : 'Resend verification'}
        </button>
        {#if resent}
          <span class="label text-success">Sent</span>
        {/if}
      </div>
    </div>
  {/if}
  <button type="submit" disabled={submitting} class="btn w-full py-3">
    {COPY.signIn.submit}
  </button>
  <div class="flex justify-end">
    <a href="/forgot-password" class="link text-sm">Forgot password?</a>
  </div>
</form>

<!-- Hidden during an invite flow: invites are email-anchored, so a mismatched
     social account would create a stray account instead of joining. -->
<SocialSignIn
  providers={inviteToken ? [] : (page.data.socialProviders ?? [])}
  callbackPath={postAuthPath}
  lastUsed={inviteToken ? null : lastAuthMethod}
/>

<p class="mt-8 text-center text-sm text-fg/70">
  No account?
  <a
    href={signUpHref}
    class="link"
    >Sign up</a
  >
</p>

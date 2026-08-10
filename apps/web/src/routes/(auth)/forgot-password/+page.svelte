<script lang="ts">
  import { authClient } from '$lib/auth-client';
  import * as Sentry from '@sentry/sveltekit';

  let email = $state('');
  let submitting = $state(false);
  let submitted = $state(false);
  let unavailable = $state(false);
  let error = $state<string | null>(null);

  async function onSubmit(event: SubmitEvent) {
    event.preventDefault();
    error = null;
    submitting = true;
    // Non-enumerating: fire the request and show the same neutral confirmation
    // no matter the result. We never reveal whether the email has an account —
    // the API also returns a neutral 200 and sends nothing for unknown emails.
    // A thrown request is a transport failure (not a signal about the account),
    // so surfacing it leaks nothing — and beats a silently stuck button.
    try {
      // requestPasswordReset resolves with { data, error } — it does not throw
      // on an API error, so the returned error has to be read explicitly or a
      // refusal sails straight into the "check your inbox" confirmation.
      const result = await authClient.requestPasswordReset({ email });
      // Exactly one refusal is worth telling the truth about. RESET_PASSWORD_DISABLED
      // (HTTP 400) means this install has no mailer that delivers, so Better Auth
      // rejects the request *before* it looks the address up — the answer is a
      // fact about the server, byte-identical for every address, so showing it
      // enumerates nothing.
      //
      // KEEP THIS BRANCH NARROW: match the code and nothing else. Every other
      // error — unknown address, rate limit, validation, anything — must keep
      // falling through to the neutral confirmation below. Widening this to
      // `result.error.status === 400`, or to any truthy error, turns the page
      // into an oracle for "does this account exist", which is precisely what
      // the neutral wording exists to prevent.
      if (result.error?.code === 'RESET_PASSWORD_DISABLED') {
        unavailable = true;
        return;
      }
      submitted = true;
    } catch (e) {
      // Report the transport failure (TMCLD-100). Capturing a network exception
      // leaks nothing about whether the account exists — this stays non-enumerating.
      Sentry.captureException(e);
      error = 'Could not reach the server. Check your connection and try again.';
    } finally {
      submitting = false;
    }
  }
</script>

<span class="eyebrow">Account recovery</span>
<h1 class="mt-3 font-serif text-3xl font-light leading-tight tracking-tight text-fg">
  Reset your password
</h1>

{#if unavailable}
  <div class="mt-8 rounded-sm border border-warning/40 bg-warning/5 px-5 py-4">
    <p class="font-serif text-lg text-fg">Reset by email isn't available here.</p>
    <p class="mt-2 text-sm leading-relaxed text-fg/75">
      Nothing was sent, and your password is unchanged. This Thalermark server has no email set up,
      so a reset link can't reach you. Ask whoever set it up to turn email on — then come back and
      try again.
    </p>
  </div>
{:else if submitted}
  <div class="callout mt-8 px-5 py-4">
    <p class="font-serif text-lg text-fg">Check your inbox.</p>
    <p class="mt-2 text-sm text-fg/75">
      If an account exists for <span class="font-medium text-fg">{email}</span>, we've sent a link to
      choose a new password. The link expires in one hour.
    </p>
  </div>
{:else}
  <p class="mt-4 text-sm text-fg/75">
    Enter your email and we'll send you a link to choose a new password.
  </p>
  <form onsubmit={onSubmit} class="mt-8 space-y-5">
    <label class="block">
      <span class="label block">Email</span>
      <input type="email" required bind:value={email} class="field-line mt-2" />
    </label>
    {#if error}
      <p class="label text-danger">{error}</p>
    {/if}
    <button type="submit" disabled={submitting} class="btn w-full py-3">
      {submitting ? 'Sending…' : 'Send reset link'}
    </button>
  </form>
{/if}

<p class="mt-8 text-center text-sm text-fg/70">
  Remembered it? <a href="/sign-in" class="link">Sign in</a>
</p>

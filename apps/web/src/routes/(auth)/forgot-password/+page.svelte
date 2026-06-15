<script lang="ts">
  import { authClient } from '$lib/auth-client';

  let email = $state('');
  let submitting = $state(false);
  let submitted = $state(false);

  async function onSubmit(event: SubmitEvent) {
    event.preventDefault();
    submitting = true;
    // Non-enumerating: fire the request and show the same neutral confirmation
    // no matter the result. We never reveal whether the email has an account —
    // the API also returns a neutral 200 and sends nothing for unknown emails.
    await authClient.requestPasswordReset({ email });
    submitting = false;
    submitted = true;
  }
</script>

<span class="eyebrow">Account recovery</span>
<h1 class="mt-3 font-serif text-3xl font-light leading-tight tracking-tight text-fg">
  Reset your password
</h1>

{#if submitted}
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
    <button type="submit" disabled={submitting} class="btn w-full py-3">
      {submitting ? 'Sending…' : 'Send reset link'}
    </button>
  </form>
{/if}

<p class="mt-8 text-center text-sm text-fg/70">
  Remembered it? <a href="/sign-in" class="link">Sign in</a>
</p>

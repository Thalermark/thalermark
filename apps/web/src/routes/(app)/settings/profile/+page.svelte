<script lang="ts">
  import ConfirmSubmit from '$lib/components/ConfirmSubmit.svelte';
  import { onMount, untrack } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import { authClient } from '$lib/auth-client';
  import PasswordStrength from '$lib/components/PasswordStrength.svelte';
  import { checkPassword } from '@thalermark/validation';

  let { data, form } = $props();

  // --- Display name ---
  // Seed the editable field from the load once; untrack so it isn't re-captured
  // reactively (matches the edit-page convention).
  let name = $state(untrack(() => data.profile.name));
  let savingName = $state(false);
  let nameError = $state<string | null>(null);
  let nameSaved = $state(false);

  async function onSaveName(event: SubmitEvent) {
    event.preventDefault();
    nameError = null;
    nameSaved = false;
    const trimmed = name.trim();
    if (!trimmed) {
      nameError = 'Name cannot be empty.';
      return;
    }
    savingName = true;
    const result = await authClient.updateUser({ name: trimmed });
    savingName = false;
    if (result.error) {
      nameError = result.error.message ?? 'Could not update your name.';
      return;
    }
    nameSaved = true;
    // Refresh the session-derived name elsewhere in the app (nav avatar/menu).
    await invalidateAll();
  }

  // --- Password ---
  let currentPassword = $state('');
  let newPassword = $state('');
  let confirmPassword = $state('');
  let changingPw = $state(false);
  let pwError = $state<string | null>(null);
  let pwDone = $state(false);

  // Does this user actually have a password? A social-only (trusted-provider)
  // sign-in has no `credential` account, so the change form doesn't apply — show
  // a "set a password" path instead. Resolved client-side after mount.
  let hasPassword = $state<boolean | null>(null);
  let sendingReset = $state(false);
  let resetSent = $state(false);

  onMount(async () => {
    const res = await authClient.listAccounts();
    hasPassword = (res.data ?? []).some((a) => a.providerId === 'credential');
  });

  async function onChangePassword(event: SubmitEvent) {
    event.preventDefault();
    pwError = null;
    pwDone = false;
    // Same policy as signup (length + not-weak/common); the server re-checks on
    // /change-password, this is just the instant client-side message.
    const check = checkPassword(newPassword);
    if (!check.ok) {
      pwError = check.message;
      return;
    }
    if (newPassword !== confirmPassword) {
      pwError = 'New passwords do not match.';
      return;
    }
    changingPw = true;
    const result = await authClient.changePassword({
      currentPassword,
      newPassword,
      revokeOtherSessions: true,
    });
    changingPw = false;
    if (result.error) {
      pwError =
        result.error.code === 'INVALID_PASSWORD'
          ? 'Your current password is incorrect.'
          : (result.error.message ?? 'Could not change your password.');
      return;
    }
    currentPassword = '';
    newPassword = '';
    confirmPassword = '';
    pwDone = true;
  }

  // Email a reset/set link to the user's own address (same flow as the
  // forgot-password page). Serves both "I forgot my current password" and the
  // social-only "set a first password" case — the server creates the credential
  // when the link is completed.
  async function onSendResetLink() {
    sendingReset = true;
    await authClient.requestPasswordReset({ email: data.profile.email });
    sendingReset = false;
    resetSent = true;
  }
</script>

<span class="eyebrow">Profile</span>
<h1 class="mt-3 font-serif text-3xl font-light tracking-tight text-fg">Your profile</h1>
<p class="mt-2 text-sm text-fg/60">Your personal details and sign-in password.</p>

<section class="mt-8 max-w-lg">
  <h2 class="label">Your details</h2>
  <form onsubmit={onSaveName} class="mt-4 space-y-4">
    <label class="block">
      <span class="label block">Display name</span>
      <input
        type="text"
        required
        bind:value={name}
        oninput={() => (nameSaved = false)}
        class="field-line mt-2"
      />
    </label>
    <label class="block">
      <span class="label block">Email</span>
      <input
        type="email"
        value={data.profile.email}
        readonly
        class="field-line mt-2 cursor-not-allowed text-fg/60"
      />
      <span class="mt-1 block text-xs text-fg/50">Email can't be changed.</span>
    </label>
    {#if nameError}
      <p class="label text-danger">{nameError}</p>
    {/if}
    <div class="flex items-center gap-4">
      <button type="submit" disabled={savingName} class="btn">
        {savingName ? 'Saving…' : 'Save'}
      </button>
      {#if nameSaved}
        <span class="label text-success">Saved</span>
      {/if}
    </div>
  </form>
</section>

<section class="mt-12 max-w-lg">
  <h2 class="label">Password</h2>

  {#if hasPassword === null}
    <p class="mt-4 text-sm text-fg/50">Loading…</p>
  {:else if hasPassword}
    {#if pwDone}
      <div class="callout mt-4 px-5 py-4">
        <p class="font-serif text-lg text-fg">Password updated.</p>
        <p class="mt-2 text-sm text-fg/75">Other devices have been signed out.</p>
      </div>
    {/if}
    <form onsubmit={onChangePassword} class="mt-4 space-y-4">
      <label class="block">
        <span class="label block">Current password</span>
        <input
          type="password"
          required
          autocomplete="current-password"
          bind:value={currentPassword}
          class="field-line mt-2"
        />
      </label>
      <label class="block">
        <span class="label block">New password</span>
        <input
          type="password"
          required
          minlength={10}
          autocomplete="new-password"
          bind:value={newPassword}
          oninput={() => (pwDone = false)}
          class="field-line mt-2"
        />
        <PasswordStrength password={newPassword} />
      </label>
      <label class="block">
        <span class="label block">Confirm new password</span>
        <input
          type="password"
          required
          minlength={10}
          autocomplete="new-password"
          bind:value={confirmPassword}
          class="field-line mt-2"
        />
      </label>
      {#if pwError}
        <p class="label text-danger">{pwError}</p>
      {/if}
      <button type="submit" disabled={changingPw} class="btn">
        {changingPw ? 'Updating…' : 'Change password'}
      </button>
    </form>
    {#if resetSent}
      <p class="mt-4 text-sm text-fg/70">
        We've emailed a reset link to <span class="font-medium text-fg">{data.profile.email}</span>.
        It expires in one hour.
      </p>
    {:else}
      <button
        type="button"
        onclick={onSendResetLink}
        disabled={sendingReset}
        class="link mt-4 text-sm"
      >
        {sendingReset ? 'Sending…' : 'Forgot your current password?'}
      </button>
    {/if}
  {:else}
    <p class="callout mt-4">
      You sign in with a connected account, so there's no password on this account to change.
    </p>
  {/if}
</section>

<!-- Deleting yourself, NOT deleting a business. Those are different doors and the
     product has both: "Close this business" under Settings → Business ends a
     company, this ends your own access to everything. Someone invited to help
     with the invoicing for three months needs this one, and it must not read as
     if it touches the books (TMC-268). -->
<section class="mt-12 rounded-sm border border-danger/30 bg-danger/5">
  <header class="border-b border-danger/20 px-6 py-5">
    <span class="eyebrow text-danger">Deleting your profile</span>
    <p class="mt-2 max-w-prose text-sm leading-relaxed text-fg/70">
      This removes you from every business you have been invited to and closes your sign-in for
      good. The work you did stays where it is: invoices you sent and expenses you logged still
      belong to those businesses, and still show your name.
    </p>
    <p class="mt-2 max-w-prose text-sm leading-relaxed text-fg/60">
      This is about you, not about a business. To wind down a business itself, use
      <a class="link" href="/settings/business">Close this business</a> instead.
    </p>
  </header>
  <div class="px-6 py-5">
    {#if form?.ownedWorkspaces?.length}
      <!-- Refused because other people are relying on them. Named, so the next
           step is obvious rather than a dead end. -->
      <div class="mb-4 rounded-sm border border-warning/40 bg-warning/5 px-4 py-3">
        <p class="text-sm text-fg">
          Other people are still working in
          {#each form.ownedWorkspaces as name, i (name)}<span class="font-medium"
              >{name}</span
            >{i < form.ownedWorkspaces.length - 1 ? ', ' : ''}{/each}, which you own.
        </p>
        <p class="mt-2 text-sm text-fg/70">
          Hand it over to someone else under <a class="link" href="/settings/team">Team</a>, or close
          the business first. Then you can delete your profile.
        </p>
      </div>
    {/if}
    {#if form?.deleteError}
      <p class="mb-4 text-sm text-danger">{form.deleteError}</p>
    {/if}
    <ConfirmSubmit
      action="?/deleteProfile"
      label="Delete my profile"
      title="Delete your profile?"
      confirmLabel="Delete my profile"
      triggerClass="rounded-sm border border-danger/40 px-3 py-1.5 text-sm font-medium text-danger transition-colors hover:bg-danger/10"
    >
      {#snippet body()}
        You are signed out everywhere and removed from every business you were invited to. You
        cannot sign back in with this email, though you could sign up again as someone new. Nothing
        anyone else owns is deleted.
      {/snippet}
    </ConfirmSubmit>
  </div>
</section>

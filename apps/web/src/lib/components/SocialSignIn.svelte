<script lang="ts">
  import { authClient } from '$lib/auth-client';

  // providers: the ids the api reports as configured (GET /api/social-providers).
  // callbackPath: where to land after the provider returns, as an app-relative
  // path — made absolute against the *web* origin at click time so the OAuth
  // bounce lands on the app (not the api origin) in dev where they differ; in
  // prod they're one origin behind Caddy. Better Auth validates the URL against
  // the api's TRUSTED_ORIGINS, where the web origin is already allow-listed.
  // lastUsed: this device's last sign-in method (provider id), read from a local
  // cookie server-side. The matching button gets a "Last used" badge — a
  // non-authoritative hint, never a reorder (the ORDER below stays fixed).
  let {
    providers = [],
    callbackPath = '/',
    lastUsed = null,
  }: { providers?: string[]; callbackPath?: string; lastUsed?: string | null } = $props();

  // Render order is fixed here (not the api's array order) so the buttons are
  // stable. Only ids present in `providers` are shown.
  const ORDER = ['google', 'facebook', 'twitter'] as const;
  type Provider = (typeof ORDER)[number];
  const LABELS: Record<Provider, string> = {
    google: 'Continue with Google',
    facebook: 'Continue with Facebook',
    twitter: 'Continue with X',
  };
  const shown = $derived(ORDER.filter((p) => providers.includes(p)));

  let submitting = $state(false);

  async function signIn(provider: Provider) {
    submitting = true;
    // Remember this device's last method so the next visit badges this button
    // (and the sign-in page suppresses its wrong-method hint). Stores only the
    // provider id — nothing identifying. Set just before the redirect so it
    // persists across the OAuth bounce.
    document.cookie = `last_auth_method=${provider}; path=/; max-age=31536000; samesite=lax`;
    // Full-page redirect to the provider; on success Better Auth bounces to
    // callbackURL. The await usually doesn't resolve (page navigates away).
    await authClient.signIn.social({
      provider,
      callbackURL: `${window.location.origin}${callbackPath}`,
    });
    submitting = false;
  }
</script>

{#snippet icon(provider: Provider)}
  {#if provider === 'google'}
    <svg class="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  {:else if provider === 'facebook'}
    <svg class="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#1877F2"
        d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07c0 6.03 4.39 11.03 10.13 11.93v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.68.24 2.68.24v2.97h-1.51c-1.49 0-1.95.93-1.95 1.88v2.26h3.32l-.53 3.49h-2.79V24C19.61 23.1 24 18.1 24 12.07z"
      />
    </svg>
  {:else}
    <svg class="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"
      />
    </svg>
  {/if}
{/snippet}

{#if shown.length > 0}
  <div class="my-6 flex items-center gap-4">
    <span class="h-px flex-1 bg-fg/15"></span>
    <span class="font-mono text-xs uppercase tracking-widest text-fg/40">or</span>
    <span class="h-px flex-1 bg-fg/15"></span>
  </div>
  <div class="space-y-3">
    {#each shown as provider (provider)}
      <button
        type="button"
        onclick={() => signIn(provider)}
        disabled={submitting}
        class="relative flex w-full items-center justify-center gap-3 rounded-sm border border-fg/25 bg-surface px-3 py-3 text-sm font-medium text-fg transition-colors hover:border-fg disabled:opacity-50"
      >
        {@render icon(provider)}
        {LABELS[provider]}
        {#if provider === lastUsed}
          <span
            class="absolute right-3 rounded-full bg-fg/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-fg/55"
          >
            Last used
          </span>
        {/if}
      </button>
    {/each}
  </div>
{/if}

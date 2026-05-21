<script lang="ts">
  import { COPY } from '@thalermark/brand';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
</script>

<span class="eyebrow">Account</span>
<h1 class="mt-3 font-serif text-3xl font-light leading-tight tracking-tight text-ink">
  {COPY.selectCompany.title}
</h1>

{#if data.memberships.length === 0}
  <div class="mt-8 rounded-sm border border-oxblood/30 bg-oxblood/5 p-5 text-sm text-ink">
    <p class="font-medium text-oxblood">Your account isn't set up yet.</p>
    <p class="mt-2 text-ink/75">
      We couldn't find any companies linked to your sign-in. This usually means your sign-up didn't
      finish. Contact support or sign out and try again.
    </p>
  </div>
{:else}
  <ul class="mt-8 divide-y divide-ink/10 rounded-sm border border-ink/10 bg-cream-warm">
    {#each data.memberships as m (m.accountId)}
      <li class="flex items-center justify-between px-5 py-4">
        <span class="font-serif text-lg text-ink">{m.name}</span>
        <form method="post">
          <input type="hidden" name="accountId" value={m.accountId} />
          <button
            type="submit"
            class="rounded-sm bg-ink px-4 py-2 text-sm font-medium text-cream transition-colors hover:bg-gold-deep"
          >
            Open
          </button>
        </form>
      </li>
    {/each}
  </ul>
{/if}

<script lang="ts">
  import { COPY } from '@thalermark/brand';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
</script>

<h1 class="text-2xl font-semibold text-primary-900">{COPY.selectCompany.title}</h1>

{#if data.memberships.length === 0}
  <div class="mt-6 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
    <p class="font-medium">Your account isn't set up yet.</p>
    <p class="mt-1">
      We couldn't find any companies linked to your sign-in. This usually means your sign-up didn't
      finish. Contact support or sign out and try again.
    </p>
  </div>
{:else}
  <ul class="mt-6 divide-y divide-primary-200 rounded-md border border-primary-200 bg-white">
    {#each data.memberships as m (m.accountId)}
      <li class="flex items-center justify-between px-4 py-3">
        <span class="text-primary-900">{m.name}</span>
        <form method="post">
          <input type="hidden" name="accountId" value={m.accountId} />
          <button
            type="submit"
            class="rounded bg-primary-900 px-3 py-1.5 text-sm text-white hover:bg-primary-700"
          >
            Open
          </button>
        </form>
      </li>
    {/each}
  </ul>
{/if}


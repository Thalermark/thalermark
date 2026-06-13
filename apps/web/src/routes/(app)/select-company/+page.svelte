<script lang="ts">
  import { COPY } from '@thalermark/brand';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
</script>

<span class="eyebrow">Workspace</span>
<h1 class="mt-3 font-serif text-3xl font-light leading-tight tracking-tight text-fg">
  {COPY.selectCompany.title}
</h1>

<!-- Pending invitations — accept joins + switches in; decline drops them. -->
{#if data.invitations.length > 0}
  <section class="mt-8 space-y-3">
    {#each data.invitations as invite (invite.token)}
      <div class="rounded-sm border border-accent/30 bg-accent/5 px-5 py-4">
        <p class="text-sm text-fg">
          {#if invite.inviterName}<span class="font-medium">{invite.inviterName}</span> is inviting you
            to join
          {:else}You've been invited to join{/if}
          <span class="font-medium">{invite.accountName}</span>.
        </p>
        <div class="mt-3 flex items-center gap-3">
          <form method="post" action="?/accept">
            <input type="hidden" name="token" value={invite.token} />
            <button
              type="submit"
              class="btn"
            >
              Accept
            </button>
          </form>
          <form method="post" action="?/decline">
            <input type="hidden" name="token" value={invite.token} />
            <button
              type="submit"
              class="rounded-sm border border-fg/30 px-4 py-2 text-sm font-medium text-fg transition-colors hover:border-fg"
            >
              Decline
            </button>
          </form>
        </div>
      </div>
    {/each}
    {#if form?.error}
      <p class="text-sm text-danger">{form.error}</p>
    {/if}
  </section>
{/if}

{#if data.memberships.length === 0 && data.invitations.length === 0}
  <div class="mt-8 rounded-sm border border-danger/30 bg-danger/5 p-5 text-sm text-fg">
    <p class="font-medium text-danger">Your workspace isn't set up yet.</p>
    <p class="mt-2 text-fg/75">
      We couldn't find any companies linked to your sign-in. This usually means your sign-up didn't
      finish. Contact support or sign out and try again.
    </p>
  </div>
{:else if data.memberships.length > 0}
  <ul class="mt-8 divide-y divide-fg/10 rounded-sm border border-fg/10 bg-surface-2">
    {#each data.memberships as m (m.accountId)}
      <li class="flex items-center justify-between px-5 py-4">
        <span class="font-serif text-lg text-fg">{m.name}</span>
        <form method="post" action="?/switch">
          <input type="hidden" name="accountId" value={m.accountId} />
          <button
            type="submit"
            class="btn"
          >
            Open
          </button>
        </form>
      </li>
    {/each}
  </ul>
{/if}

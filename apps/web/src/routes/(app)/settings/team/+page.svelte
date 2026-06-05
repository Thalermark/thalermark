<script lang="ts">
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();

  // Date-only formatter; matches the lightweight, dep-free approach in
  // AuditHistory rather than pulling in a date library for one use site.
  function formatDate(iso: string): string {
    return new Date(iso).toISOString().slice(0, 10);
  }
</script>

<h1 class="font-serif text-4xl font-light leading-none tracking-tight text-ink">
  Team<span class="text-gold-deep">.</span>
</h1>
<p class="mt-3 text-sm text-ink/60">
  Everyone here shares full access to this account. Invite a teammate by email — they'll get a link
  to join.
</p>

<!-- Current members -->
<section class="mt-8 rounded-sm border border-ink/15 bg-cream-warm">
  <header class="border-b border-ink/10 px-6 py-5">
    <span class="eyebrow">Members</span>
  </header>
  <ul class="divide-y divide-ink/10">
    {#each data.members as member (member.userId)}
      <li class="flex items-center justify-between px-6 py-4">
        <div>
          <p class="font-serif text-lg text-ink">
            {member.name}
            {#if member.isYou}
              <span class="ml-2 font-mono text-xs uppercase tracking-widest text-ink/40">You</span>
            {/if}
          </p>
          <p class="text-sm text-ink/60">{member.email}</p>
        </div>
        <span class="text-sm text-ink/50">Joined {formatDate(member.joinedAt)}</span>
      </li>
    {/each}
  </ul>
</section>

<!-- Invite form -->
<section class="mt-6 rounded-sm border border-ink/15 bg-cream-warm">
  <header class="border-b border-ink/10 px-6 py-5">
    <span class="eyebrow">Invite a teammate</span>
  </header>
  <form method="POST" action="?/invite" class="px-6 py-6">
    <label class="block">
      <span class="font-mono text-xs uppercase tracking-widest text-ink/50">Email address</span>
      <input
        type="email"
        name="email"
        value={form?.invited ? '' : (form?.email ?? '')}
        required
        placeholder="teammate@example.com"
        class="mt-2 w-full max-w-md rounded-sm border border-ink/20 bg-cream px-3 py-2 text-sm text-ink focus:border-gold-deep focus:outline-none"
      />
    </label>
    <div class="mt-5 flex items-center gap-4">
      <button
        type="submit"
        class="rounded-sm bg-ink px-4 py-2 text-sm font-medium text-cream transition-colors hover:bg-gold-deep"
      >
        Send invite
      </button>
      {#if form?.invited}
        <span class="text-sm text-ink/60">Invite sent to {form.invited}.</span>
      {:else if form?.error}
        <span class="text-sm text-rose-700">{form.error}</span>
      {/if}
    </div>
  </form>
</section>

<!-- Pending invitations -->
{#if data.invitations.length > 0}
  <section class="mt-6 rounded-sm border border-ink/15 bg-cream-warm">
    <header class="border-b border-ink/10 px-6 py-5">
      <span class="eyebrow">Pending invitations</span>
    </header>
    <ul class="divide-y divide-ink/10">
      {#each data.invitations as invite (invite.id)}
        <li class="flex items-center justify-between px-6 py-4">
          <div>
            <p class="text-sm text-ink">{invite.email}</p>
            <p class="text-sm text-ink/50">Sent {formatDate(invite.createdAt)}</p>
          </div>
          {#if invite.expired}
            <span class="font-mono text-xs uppercase tracking-widest text-rose-700">Expired</span>
          {:else}
            <span class="text-sm text-ink/50">Expires {formatDate(invite.expiresAt)}</span>
          {/if}
        </li>
      {/each}
    </ul>
  </section>
{/if}

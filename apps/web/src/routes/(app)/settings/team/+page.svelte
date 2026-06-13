<script lang="ts">
  import { type Role, can, INVITE_ROLES } from '@thalermark/validation';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();

  const ROLE_LABELS: Record<string, string> = {
    owner: 'Owner',
    admin: 'Admin',
    member: 'Member',
    accountant: 'Accountant',
    viewer: 'Viewer',
  };

  // The viewer's own role drives which controls render; the API is the real
  // authority — these gates only keep the UI honest.
  const myRole = $derived((data.members.find((m) => m.isYou)?.role ?? 'viewer') as Role);
  const canManageTeam = $derived(can(myRole, 'team:manage'));
  const canTransfer = $derived(can(myRole, 'workspace:manage'));

  // Date-only formatter; matches the lightweight, dep-free approach in
  // AuditHistory rather than pulling in a date library for one use site.
  function formatDate(iso: string): string {
    return new Date(iso).toISOString().slice(0, 10);
  }
</script>

<h1 class="font-serif text-4xl font-light leading-none tracking-tight text-fg">
  Team<span class="text-accent">.</span>
</h1>
<p class="mt-3 text-sm text-fg/60">
  Invite teammates and set what each can do — from full admins to view-only accountants. The owner
  has complete control; everyone else gets the access their role grants.
</p>

<!-- Current members -->
<section class="mt-8 rounded-sm border border-fg/15 bg-surface-2">
  <header class="border-b border-fg/10 px-6 py-5">
    <span class="eyebrow">Members</span>
  </header>
  <ul class="divide-y divide-fg/10">
    {#each data.members as member (member.userId)}
      <li class="flex items-center justify-between px-6 py-4">
        <div>
          <p class="font-serif text-lg text-fg">
            {member.name}
            {#if member.isYou}
              <span class="ml-2 font-mono text-xs uppercase tracking-widest text-fg/40">You</span>
            {/if}
          </p>
          <p class="text-sm text-fg/60">{member.email}</p>
        </div>
        <div class="flex items-center gap-4">
          <span class="hidden text-sm text-fg/50 sm:inline">Joined {formatDate(member.joinedAt)}</span>

          <!-- Role: badge for the owner / self / read-only viewers; an inline
               select for a team manager looking at another member. -->
          {#if member.role === 'owner'}
            <span class="font-mono text-xs uppercase tracking-widest text-accent">Owner</span>
          {:else if canManageTeam && !member.isYou}
            <form method="POST" action="?/changeRole">
              <input type="hidden" name="userId" value={member.userId} />
              <select
                name="role"
                value={member.role}
                onchange={(e) => e.currentTarget.form?.requestSubmit()}
                aria-label="Role for {member.name}"
                class="rounded-sm border border-fg/20 bg-surface px-2 py-1.5 text-sm text-fg focus:border-accent focus:outline-none"
              >
                {#each INVITE_ROLES as r (r)}
                  <option value={r}>{ROLE_LABELS[r]}</option>
                {/each}
              </select>
            </form>
          {:else}
            <span class="font-mono text-xs uppercase tracking-widest text-fg/40">
              {ROLE_LABELS[member.role] ?? member.role}
            </span>
          {/if}

          <!-- Actions -->
          {#if member.isYou && member.role !== 'owner'}
            <form method="POST" action="?/leave">
              <button
                type="submit"
                class="rounded-sm border border-fg/30 px-3 py-1.5 text-sm font-medium text-fg transition-colors hover:border-danger hover:text-danger"
              >
                Leave
              </button>
            </form>
          {:else if member.role !== 'owner'}
            {#if canTransfer}
              <form
                method="POST"
                action="?/transfer"
                onsubmit={(e) => {
                  if (!confirm(`Make ${member.name} the owner? You'll become an admin.`))
                    e.preventDefault();
                }}
              >
                <input type="hidden" name="userId" value={member.userId} />
                <button
                  type="submit"
                  class="rounded-sm border border-fg/30 px-3 py-1.5 text-sm font-medium text-fg transition-colors hover:border-accent hover:text-accent"
                >
                  Make owner
                </button>
              </form>
            {/if}
            {#if canManageTeam}
              <form method="POST" action="?/remove">
                <input type="hidden" name="userId" value={member.userId} />
                <button
                  type="submit"
                  class="rounded-sm border border-fg/30 px-3 py-1.5 text-sm font-medium text-fg transition-colors hover:border-danger hover:text-danger"
                >
                  Remove
                </button>
              </form>
            {/if}
          {/if}
        </div>
      </li>
    {/each}
  </ul>
  {#if form?.memberError}
    <p class="border-t border-fg/10 px-6 py-4 text-sm text-danger">{form.memberError}</p>
  {:else if form?.roleChanged}
    <p class="border-t border-fg/10 px-6 py-4 text-sm text-fg/60">Role updated.</p>
  {:else if form?.transferred}
    <p class="border-t border-fg/10 px-6 py-4 text-sm text-fg/60">Ownership transferred.</p>
  {/if}
</section>

<!-- Invite form (only for roles that can manage the team) -->
{#if canManageTeam}
  <section class="mt-6 rounded-sm border border-fg/15 bg-surface-2">
    <header class="border-b border-fg/10 px-6 py-5">
      <span class="eyebrow">Invite a teammate</span>
    </header>
    <form method="POST" action="?/invite" class="px-6 py-6">
      <div class="flex flex-wrap items-end gap-4">
        <label class="block">
          <span class="label">Email address</span>
          <input
            type="email"
            name="email"
            value={form?.invited ? '' : (form?.email ?? '')}
            required
            placeholder="teammate@example.com"
            class="mt-2 w-full max-w-md rounded-sm border border-fg/20 bg-surface px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
          />
        </label>
        <label class="block">
          <span class="label">Role</span>
          <select
            name="role"
            class="mt-2 rounded-sm border border-fg/20 bg-surface px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
          >
            {#each INVITE_ROLES as r (r)}
              <option value={r} selected={r === 'member'}>{ROLE_LABELS[r]}</option>
            {/each}
          </select>
        </label>
      </div>
      <div class="mt-5 flex items-center gap-4">
        <button
          type="submit"
          class="btn"
        >
          Send invite
        </button>
        {#if form?.invited}
          <span class="text-sm text-fg/60">Invite sent to {form.invited}.</span>
        {:else if form?.error}
          <span class="text-sm text-danger">{form.error}</span>
        {/if}
      </div>
    </form>
  </section>
{/if}

<!-- Pending invitations -->
{#if data.invitations.length > 0}
  <section class="mt-6 rounded-sm border border-fg/15 bg-surface-2">
    <header class="border-b border-fg/10 px-6 py-5">
      <span class="eyebrow">Pending invitations</span>
    </header>
    <ul class="divide-y divide-fg/10">
      {#each data.invitations as invite (invite.id)}
        <li class="flex items-center justify-between px-6 py-4">
          <div>
            <p class="text-sm text-fg">{invite.email}</p>
            <p class="text-sm text-fg/50">Sent {formatDate(invite.createdAt)}</p>
          </div>
          {#if invite.declined}
            <span class="font-mono text-xs uppercase tracking-widest text-fg/40">Declined</span>
          {:else if invite.expired}
            <span class="font-mono text-xs uppercase tracking-widest text-danger">Expired</span>
          {:else}
            <span class="text-sm text-fg/50">Expires {formatDate(invite.expiresAt)}</span>
          {/if}
        </li>
      {/each}
    </ul>
  </section>
{/if}

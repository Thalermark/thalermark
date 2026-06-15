<script lang="ts">
  import AuditHistory from '$lib/components/AuditHistory.svelte';
  import { may } from '$lib/perms';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const policy = $derived(data.policy);
  const archived = $derived(policy.archivedAt !== null);

  // Tax policies are company configuration — gated on settings:manage (the API
  // is authoritative; this only hides controls).
  const canManage = $derived(may(data.role, 'settings:manage'));

  const ratePct = (s: string) => `${Number(s)}%`;
</script>

<a href="/settings/tax-policies" class="eyebrow text-fg/60 hover:text-fg">← Tax policies</a>
<div class="mt-3 flex items-baseline justify-between gap-6">
  <h1 class="font-serif text-4xl font-light leading-none tracking-tight text-fg">
    {policy.name}<span class="text-accent">.</span>
    {#if policy.isDefault}
      <span
        class="ml-2 align-middle rounded-sm border border-accent/40 px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-widest text-accent"
      >
        Default
      </span>
    {/if}
    {#if archived}
      <span
        class="ml-2 align-middle rounded-sm border border-fg/15 px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-widest text-fg/50"
      >
        Archived
      </span>
    {/if}
  </h1>
  {#if canManage}
    <div class="flex items-center gap-2">
      <a
        href="/settings/tax-policies/{policy.id}/edit"
        class="rounded-sm border border-fg/20 px-3 py-1 font-mono text-xs uppercase tracking-widest text-fg/70 hover:border-accent hover:text-accent"
      >
        Edit
      </a>
      <form method="post" action={archived ? '?/restore' : '?/archive'}>
        <button
          type="submit"
          class="rounded-sm border border-fg/20 px-3 py-1 font-mono text-xs uppercase tracking-widest text-fg/70 hover:border-accent hover:text-accent"
        >
          {archived ? 'Restore' : 'Archive'}
        </button>
      </form>
    </div>
  {/if}
</div>

{#if archived}
  <p class="mt-6 rounded-sm border border-fg/15 bg-surface-2 px-4 py-3 text-sm text-fg/70">
    This policy is archived — it won't appear in the tax pickers. Lines already taxed under it keep
    their rate.
  </p>
{/if}

<dl class="mt-8 grid grid-cols-1 gap-x-12 gap-y-6 sm:grid-cols-2">
  <div>
    <dt class="label">Rate</dt>
    <dd class="mt-1 text-fg">{ratePct(policy.ratePct)}</dd>
  </div>
  <div>
    <dt class="label">Default</dt>
    <dd class="mt-1 text-fg">{policy.isDefault ? 'Yes' : 'No'}</dd>
  </div>
</dl>

<AuditHistory events={data.auditEvents} />

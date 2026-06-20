<script lang="ts">
  import { page } from '$app/state';
  import type { Capability } from '@thalermark/validation';
  import { may } from '$lib/perms';

  let { children } = $props();

  // Vertical tab nav for the settings area. Adding a tab = one entry here
  // plus the matching /settings/<slug> route. Active match is exact-prefix
  // so /settings/activity highlights "Activity" but /settings doesn't
  // highlight anything (the index page redirects to a default tab so the
  // empty state is unreachable in practice).
  //
  // A `cap` hides the tab for roles that can't use it (UX only — the API and
  // each tab's own actions stay authoritative). Tabs without a cap are plain
  // reads (Activity feed, Items catalog, Team roster) open to every role.
  const TABS: { href: string; label: string; cap?: Capability }[] = [
    { href: '/settings/activity', label: 'Activity' },
    { href: '/settings/business', label: 'Business', cap: 'settings:manage' },
    { href: '/settings/items', label: 'Items' },
    { href: '/settings/import', label: 'Import', cap: 'customers:write' },
    { href: '/settings/tax-policies', label: 'Tax', cap: 'settings:manage' },
    { href: '/settings/team', label: 'Team' },
    { href: '/settings/payments', label: 'Payments', cap: 'settings:manage' },
    { href: '/settings/email', label: 'Email', cap: 'settings:manage' },
    { href: '/settings/privacy', label: 'Privacy', cap: 'settings:manage' },
  ];
  const visibleTabs = $derived(TABS.filter((t) => !t.cap || may(page.data.role, t.cap)));

  const path = $derived(page.url.pathname);
  function isActive(href: string): boolean {
    return path === href || path.startsWith(`${href}/`);
  }
</script>

<div class="grid gap-10 lg:grid-cols-[14rem_1fr]">
  <aside>
    <span class="eyebrow">Settings</span>
    <nav class="mt-4 flex flex-col gap-1">
      {#each visibleTabs as tab (tab.href)}
        {@const active = isActive(tab.href)}
        <a
          href={tab.href}
          class="rounded-sm px-3 py-2 text-sm transition-colors {active
            ? 'bg-surface-2 text-fg'
            : 'text-fg/60 hover:bg-surface-2 hover:text-fg'}"
        >
          {tab.label}
        </a>
      {/each}
    </nav>
  </aside>
  <div>
    {@render children()}
  </div>
</div>

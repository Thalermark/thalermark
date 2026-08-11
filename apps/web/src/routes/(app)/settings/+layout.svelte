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
  // reads (Activity feed, Team roster) open to every role. (The Items catalog
  // moved out to the top-level /items nav entry.)
  //
  // Grouped rather than a flat list of twelve. The split is who or what each
  // one is about: you, the business, or the data itself.
  //
  // `anyCap` shows a tab if the role has ANY of the listed capabilities —
  // needed since Import & export merged two tabs that were gated differently.
  type Tab = { href: string; label: string; cap?: Capability; anyCap?: Capability[] };
  const GROUPS: { title: string; tabs: Tab[] }[] = [
    {
      title: 'Your account',
      tabs: [
        { href: '/settings/profile', label: 'Profile' },
        { href: '/settings/team', label: 'Team' },
        { href: '/settings/privacy', label: 'Privacy', cap: 'settings:manage' },
      ],
    },
    {
      title: 'Your business',
      tabs: [
        { href: '/settings/business', label: 'Business', cap: 'settings:manage' },
        // "Accounts" rather than "Chart of accounts" — the user is adding the
        // bank account and card they actually have, not editing a ledger.
        { href: '/settings/accounts', label: 'Accounts', cap: 'settings:manage' },
        { href: '/settings/tax-policies', label: 'Tax', cap: 'settings:manage' },
        { href: '/settings/payments', label: 'Payments', cap: 'settings:manage' },
        { href: '/settings/email', label: 'Email templates', cap: 'settings:manage' },
        { href: '/settings/reminders', label: 'Reminders', cap: 'settings:manage' },
        { href: '/settings/ai', label: 'AI', cap: 'settings:manage' },
      ],
    },
    {
      title: 'Data',
      tabs: [
        {
          href: '/settings/import',
          label: 'Import & export',
          anyCap: ['contacts:write', 'reports:export'],
        },
        { href: '/settings/activity', label: 'Activity' },
        { href: '/settings/about', label: 'About' },
      ],
    },
  ];

  function allowed(t: Tab): boolean {
    if (t.anyCap) return t.anyCap.some((c) => may(page.data.role, c));
    return !t.cap || may(page.data.role, t.cap);
  }
  // Drop a whole group if the role can't see any of its tabs.
  const visibleGroups = $derived(
    GROUPS.map((g) => ({ ...g, tabs: g.tabs.filter(allowed) })).filter((g) => g.tabs.length > 0),
  );

  const path = $derived(page.url.pathname);
  function isActive(href: string): boolean {
    return path === href || path.startsWith(`${href}/`);
  }
</script>

<div class="grid gap-10 lg:grid-cols-[14rem_1fr]">
  <aside>
    <span class="eyebrow">Settings</span>
    <nav class="mt-4 flex flex-col gap-6">
      {#each visibleGroups as group (group.title)}
        <div class="flex flex-col gap-1">
          <span class="px-3 font-mono text-[0.65rem] uppercase tracking-widest text-fg/40">
            {group.title}
          </span>
          {#each group.tabs as tab (tab.href)}
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
        </div>
      {/each}
    </nav>
  </aside>
  <div>
    {@render children()}
  </div>
</div>

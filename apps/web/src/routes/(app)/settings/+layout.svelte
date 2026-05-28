<script lang="ts">
  import { page } from '$app/state';

  let { children } = $props();

  // Vertical tab nav for the settings area. Adding a tab = one entry here
  // plus the matching /settings/<slug> route. Active match is exact-prefix
  // so /settings/activity highlights "Activity" but /settings doesn't
  // highlight anything (the index page redirects to a default tab so the
  // empty state is unreachable in practice).
  const TABS: { href: string; label: string }[] = [
    { href: '/settings/activity', label: 'Activity' },
    { href: '/settings/payments', label: 'Payments' },
  ];

  const path = $derived(page.url.pathname);
  function isActive(href: string): boolean {
    return path === href || path.startsWith(`${href}/`);
  }
</script>

<div class="grid gap-10 lg:grid-cols-[14rem_1fr]">
  <aside>
    <span class="eyebrow">Settings</span>
    <nav class="mt-4 flex flex-col gap-1">
      {#each TABS as tab (tab.href)}
        {@const active = isActive(tab.href)}
        <a
          href={tab.href}
          class="rounded-sm px-3 py-2 text-sm transition-colors {active
            ? 'bg-cream-warm text-ink'
            : 'text-ink/60 hover:bg-cream-warm hover:text-ink'}"
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

<script lang="ts">
  import { onMount } from 'svelte';

  // Three-state preference: 'system' follows the OS; 'light'/'dark' pin a choice
  // and persist to localStorage. The pre-paint init script in app.html reads the
  // same key — keep the dark-resolution logic here in sync with it.
  type Theme = 'system' | 'light' | 'dark';
  const OPTIONS: { value: Theme; label: string }[] = [
    { value: 'system', label: 'Auto' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
  ];

  let theme = $state<Theme>('system');
  let mql: MediaQueryList | null = null;

  function apply(t: Theme) {
    const dark = t === 'dark' || (t === 'system' && !!mql?.matches);
    document.documentElement.classList.toggle('dark', dark);
    // Keep the mobile browser chrome (status bar) in step with the surface.
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#0f1626' : '#f4ede0');
  }

  function select(t: Theme) {
    theme = t;
    if (t === 'system') localStorage.removeItem('theme');
    else localStorage.setItem('theme', t);
    apply(t);
  }

  onMount(() => {
    mql = window.matchMedia('(prefers-color-scheme: dark)');
    const stored = localStorage.getItem('theme');
    theme = stored === 'dark' || stored === 'light' ? stored : 'system';
    // While on Auto, track live OS theme changes.
    const onChange = () => {
      if (theme === 'system') apply('system');
    };
    mql.addEventListener('change', onChange);
    return () => mql?.removeEventListener('change', onChange);
  });
</script>

<div class="px-4 py-2">
  <p class="pb-1.5 font-mono text-[10px] uppercase tracking-widest text-fg/40">Theme</p>
  <div class="flex gap-1 rounded-sm border border-fg/15 p-0.5">
    {#each OPTIONS as opt (opt.value)}
      <button
        type="button"
        onclick={() => select(opt.value)}
        aria-pressed={theme === opt.value}
        class="flex-1 rounded-[2px] py-1 text-center font-mono text-[11px] uppercase tracking-wide transition-colors
          {theme === opt.value ? 'bg-inverse text-on-inverse' : 'text-fg/60 hover:text-fg'}"
      >
        {opt.label}
      </button>
    {/each}
  </div>
</div>

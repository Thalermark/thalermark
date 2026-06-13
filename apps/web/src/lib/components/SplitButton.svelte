<script lang="ts">
  import type { Snippet } from 'svelte';

  // A split button: a primary action joined to a caret that opens a dropdown
  // menu. The consumer supplies the `primary` (a submit or toggle button styled
  // with left-only rounding) and the `menu` contents; this component owns the
  // caret, the open state, and outside-click / Escape dismissal (same idiom as
  // UserMenu). `caretClass` lets each call site match the caret to its primary,
  // and the menu snippet receives a `close` fn so items can dismiss on select.
  let {
    primary,
    menu,
    caretClass = 'border border-fg/20 bg-surface-2 text-fg hover:border-accent hover:text-accent',
    label = 'More options',
  }: {
    primary: Snippet;
    menu: Snippet<[() => void]>;
    caretClass?: string;
    label?: string;
  } = $props();

  let open = $state(false);
  let root: HTMLDivElement | undefined = $state();
  const close = () => {
    open = false;
  };
  function onDocumentClick(event: MouseEvent) {
    if (open && root && !root.contains(event.target as Node)) close();
  }
  function onKey(event: KeyboardEvent) {
    if (open && event.key === 'Escape') close();
  }
</script>

<svelte:window onclick={onDocumentClick} onkeydown={onKey} />

<div bind:this={root} class="relative inline-flex">
  <div class="inline-flex items-stretch">
    {@render primary()}
    <button
      type="button"
      onclick={() => {
        open = !open;
      }}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={label}
      class="flex items-center rounded-r-sm px-2 transition-colors focus:outline-none {caretClass}"
    >
      <svg
        viewBox="0 0 12 12"
        class="size-3"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        aria-hidden="true"
      >
        <path d="M3 4.5 6 7.5 9 4.5" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
  </div>
  {#if open}
    <div
      role="menu"
      class="absolute right-0 top-full z-10 mt-1 min-w-52 rounded-sm border border-fg/10 bg-surface py-1 shadow-lg"
    >
      {@render menu(close)}
    </div>
  {/if}
</div>

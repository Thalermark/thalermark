<script lang="ts">
  import type { Snippet } from 'svelte';

  // A confirmation step for something that cannot be taken back (TMC-217).
  //
  // Built on the native <dialog> deliberately. showModal() gives us the focus
  // trap, Escape-to-dismiss, inert background and ::backdrop that a div-based
  // modal has to reimplement badly — and there was no house modal to copy, so
  // this is the first one and it may as well be the accessible one.
  //
  // The cancel button takes focus, not the confirm button. Someone who hits
  // Enter out of habit should not thereby delete a receipt.

  type Props = {
    open: boolean;
    // Phrased as the question being asked: "Delete this expense?"
    title: string;
    // What will actually happen, in the user's terms. Required, because a
    // dialog that only says "Are you sure?" moves the click without adding the
    // one thing that makes it worth interrupting someone for.
    body: Snippet;
    confirmLabel: string;
    cancelLabel?: string;
    onconfirm: () => void;
    ondismiss?: () => void;
  };

  let {
    open = $bindable(),
    title,
    body,
    confirmLabel,
    cancelLabel = 'Cancel',
    onconfirm,
    ondismiss,
  }: Props = $props();

  let el: HTMLDialogElement | null = $state(null);

  // Drive the element from the prop rather than the other way round, guarding
  // both directions: showModal() on an already-open dialog throws.
  $effect(() => {
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  });

  function dismiss() {
    open = false;
    ondismiss?.();
  }

  function confirm() {
    open = false;
    onconfirm();
  }
</script>

<dialog
  bind:this={el}
  class="max-w-md rounded-sm border border-fg/15 bg-surface-2 p-0 text-fg shadow-lg backdrop:bg-ink/60"
  onclose={dismiss}
  onclick={(e) => {
    // The dialog's own box is the panel (p-0), so anything clicked inside it
    // targets a child. A target of the dialog itself therefore means the
    // backdrop — no stopPropagation needed on the panel.
    if (e.target === el) dismiss();
  }}
>
  <div class="px-6 py-5">
    <h2 class="font-serif text-xl font-light leading-tight text-fg">{title}</h2>
    <div class="mt-3 text-sm leading-relaxed text-fg/70">
      {@render body()}
    </div>
    <div class="mt-6 flex justify-end gap-3">
      <!-- Autofocused: the safe option is the one your fingers land on. -->
      <!-- svelte-ignore a11y_autofocus -->
      <button type="button" class="btn-ghost btn-sm" autofocus onclick={dismiss}>
        {cancelLabel}
      </button>
      <button type="button" class="btn-danger btn-sm" onclick={confirm}>
        {confirmLabel}
      </button>
    </div>
  </div>
</dialog>

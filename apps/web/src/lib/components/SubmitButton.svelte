<script lang="ts">
  // A submit button that says it is working, and refuses to be pressed twice
  // (TMC-218).
  //
  // The money-moving forms posted plainly with no feedback at all: "Send
  // invoice" makes an SMTP round trip, and until it came back the button did
  // not change, nothing on the page moved, and the only sign of life was the
  // browser's tab spinner. On a slow connection that reads as a dead click, and
  // a dead click invites a second one — which on "Record payment" used to post
  // the receipt twice.
  //
  // Deliberately NOT built on use:enhance, which is what the ticket suggested.
  // These forms are plain POSTs; the browser navigates on success and re-renders
  // on failure, so the pending state clears itself and no extra machinery is
  // needed. Enhance would mean intercepting submits on four of the most
  // load-bearing pages in the app, and it ignores `event.defaultPrevented` (see
  // ConfirmSubmit), so it does not compose with the confirmation dialogs that
  // now sit on the same forms. The button is the smaller, safer surface.
  //
  // ⚠️ It follows that this component assumes a NON-enhanced form: `pending`
  // clears on navigation, not on a promise resolving. Inside an enhanced form it
  // would latch on after a failed submit. Reset it from the enhance callback if
  // that day comes.
  //
  // The double-click guard here is real but shallow — it stops the fumbled
  // double-press, not two tabs or a back-button resubmit. The guarantee lives in
  // the partial unique index on the payments tables; this is the half that makes
  // the app feel like it is listening.

  type Props = {
    label: string;
    /** Shown while the request is in flight. Present tense, not a spinner-noun. */
    pendingLabel?: string;
    class?: string;
    disabled?: boolean;
    /** For a button that posts somewhere other than its form's action. */
    formaction?: string;
    /** Skip the form's constraint validation — for a secondary submitter that
     *  does not need the optional fields the primary one validates. */
    formnovalidate?: boolean;
    /** e.g. "menuitem" when the button lives in a SplitButton menu. */
    role?: string;
  };

  let {
    label,
    pendingLabel = 'Working…',
    class: className = 'btn',
    disabled = false,
    formaction,
    formnovalidate = false,
    role,
  }: Props = $props();

  let el: HTMLButtonElement | null = $state(null);
  // `mine` — this button submitted, so it swaps its label.
  // `busy`  — some button in this form submitted, so every one of them locks.
  // Two flags because a form can carry several submitters (formaction), and
  // "Void" should not start reading "Sending…" because Send was pressed.
  let mine = $state(false);
  let busy = $state(false);

  $effect(() => {
    const form = el?.form;
    if (!form) return;
    function onSubmit(e: SubmitEvent) {
      // A submit that something else cancelled — a confirmation dialog opening,
      // for instance — is not in flight and must not lock the button.
      if (e.defaultPrevented) return;
      busy = true;
      if (e.submitter === el) mine = true;
    }
    form.addEventListener('submit', onSubmit);
    return () => form.removeEventListener('submit', onSubmit);
  });
</script>

<button
  bind:this={el}
  type="submit"
  class={className}
  disabled={disabled || busy}
  {formaction}
  {formnovalidate}
  {role}
  aria-busy={mine}
>
  {mine ? pendingLabel : label}
</button>

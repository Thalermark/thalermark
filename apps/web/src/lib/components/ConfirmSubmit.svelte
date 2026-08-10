<script lang="ts">
  import type { Snippet } from 'svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';

  // A form POST that asks first (TMC-217).
  //
  // Renders the form, its trigger and its own dialog, so a call site costs one
  // element instead of three pieces of state. Inside an {#each} that matters:
  // each row gets its own instance and its own open flag, with no keying by id.
  //
  // The no-JS path is deliberately preserved. The trigger stays a real
  // type="submit" and the interception lives on the form's submit event, so
  // with scripting off the POST goes through exactly as it did before —
  // unconfirmed, but never broken. A `type="button"` trigger would have been
  // simpler and would have quietly removed the action for those users.
  //
  // ⚠️ DO NOT add `use:enhance` to this form. SvelteKit's enhance handler never
  // checks `event.defaultPrevented` — it calls preventDefault() itself and
  // fetches regardless. Enhancing this form would therefore open the dialog AND
  // fire the request: the exact bug this component exists to prevent, wearing a
  // confirmation dialog. An already-enhanced form must instead intercept with
  // enhance's own `cancel()`; `purchases/[id]/+page.svelte` does it that way and
  // is the reference for that case.

  type Props = {
    /** SvelteKit form action, e.g. "?/void". */
    action: string;
    /** The question: "Void this invoice?" */
    title: string;
    /** What actually happens, in the user's terms. */
    body: Snippet;
    /** The verb on the confirming button: "Void invoice". */
    confirmLabel: string;
    /** The trigger's visible text. */
    label: string;
    /** Trigger classes. Defaults to the quiet outline — a destructive control
     *  should not be the loudest thing on the page. */
    triggerClass?: string;
    /** Extra fields to post, e.g. { paymentId: p.id }. */
    hidden?: Record<string, string>;
    /** Classes for the generated <form>, where the original carried layout. */
    formClass?: string;
    disabled?: boolean;
  };

  let {
    action,
    title,
    body,
    confirmLabel,
    label,
    triggerClass = 'btn-ghost btn-sm',
    hidden,
    formClass,
    disabled = false,
  }: Props = $props();

  let form: HTMLFormElement | null = $state(null);
  let open = $state(false);
  // Plain let, not $state: it gates one synchronous re-submit and nothing
  // renders from it.
  let confirmed = false;

  function intercept(e: SubmitEvent) {
    if (confirmed) return; // second pass, post-confirmation — let it fly
    e.preventDefault();
    open = true;
  }

  function go() {
    confirmed = true;
    // requestSubmit re-fires this form's submit event (unlike submit()), which
    // is why the guard above exists rather than a detached handler.
    form?.requestSubmit();
  }
</script>

<form method="post" {action} class={formClass} bind:this={form} onsubmit={intercept}>
  {#each Object.entries(hidden ?? {}) as [name, value] (name)}
    <input type="hidden" {name} {value} />
  {/each}
  <button type="submit" class={triggerClass} {disabled}>{label}</button>
</form>

<ConfirmDialog bind:open {title} {body} {confirmLabel} onconfirm={go} />

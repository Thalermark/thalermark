import type { SubmitFunction } from '@sveltejs/kit';
import { tick } from 'svelte';

// Progressive enhancement for the long data-entry forms, with the one thing
// SvelteKit's default `use:enhance` cannot know about (TMC-248).
//
// Plain form posts used to reload the page on failure, which scrolled the user
// to the top where the error banner is. Enhancing the form removed the reload —
// which is the entire point, because the reload is what re-ran `load`, hit the
// dead API and threw away everything the user had typed — but it also removed
// the scroll. On a 565-line invoice form the banner then renders 500 lines above
// the Save button the user is looking at, and pressing Save appears to do
// nothing at all.
//
// So: keep the default behaviour, then bring the message to the user.
export const enhanceForm: SubmitFunction = () => {
  return async ({ result, update }) => {
    // The default: invalidate + apply on success, apply only on failure. Not
    // reimplemented here — `update` IS SvelteKit's own handler.
    await update();
    if (result.type !== 'failure') return;

    // The banner is rendered by the `{#if form?.formError}` block that `update`
    // just populated, so it does not exist until the DOM catches up.
    await tick();
    const banner = document.querySelector<HTMLElement>('[data-form-error]');
    if (!banner) {
      // No marked banner on this page: fall back to what the page reload did.
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    banner.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Focus as well as scroll: it moves the keyboard user to the message rather
    // than leaving them at the bottom of a form that silently refused, and it is
    // what makes the `role="alert"` announcement land somewhere useful.
    banner.focus({ preventScroll: true });
  };
};

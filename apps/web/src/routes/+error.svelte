<script lang="ts">
  import { page } from '$app/state';
  import { isPublicPrefix } from '$lib/public-routes';

  // Root error boundary — the branded replacement for SvelteKit's default error
  // page. Renders for unmatched routes and for genuine faults (500). 404s are
  // expected errors and are NOT reported to GlitchTip — handleError only reports
  // unexpected ones — so this is purely the user-facing page. The root layout is
  // bare (just app.css), so this page carries its own wordmark + centering, like
  // the (auth) layout.
  const notFound = $derived(page.status === 404);

  // A comment here used to claim signed-out visitors never reach this page. They
  // do: /i/ and /e/ are public, so the recipient of an invoice whose link has
  // expired or been revoked lands here with no session at all (TMC-237). The old
  // page then offered them Invoices / Estimates / Expenses / Contacts / Reports
  // and "Back to dashboard", every one of which bounces a stranger to /sign-in.
  const isRecipient = $derived(isPublicPrefix(page.url.pathname));

  // The message is a fragment from a `throw error(...)` somewhere upstream, and
  // there are ~45 of them, all lowercase and mid-sentence. Splicing one into
  // "…{message} Please try again in a moment." produced sentences like
  // "Something went wrong. no company in this workspace Please try again in a
  // moment." Capitalising and terminating it here fixes every site at once,
  // rather than editing 45 throw calls into prose.
  const detail = $derived.by(() => {
    const raw = page.error?.message?.trim();
    if (!raw) return 'An unexpected error occurred.';
    const sentence = raw[0].toUpperCase() + raw.slice(1);
    return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
  });

  // "Please try again in a moment" is advice, and it is only true for a fault
  // that might pass. Telling someone to wait out a 403 is wrong: waiting will
  // never grant them admin access.
  const worthRetrying = $derived(page.status >= 500);
</script>

<svelte:head>
  <title>{notFound ? 'Page not found' : 'Something went wrong'} · Thalermark</title>
</svelte:head>

<div class="flex min-h-screen flex-col">
  <nav class="px-6 py-8">
    <div class="mx-auto max-w-5xl">
      <a href="/" class="wordmark wordmark-small text-fg" aria-label="Thalermark home">
        <span class="strike"></span>
        <span class="word">thalermark</span>
      </a>
    </div>
  </nav>

  <main class="flex flex-1 items-center justify-center px-6 pb-24">
    <div class="w-full max-w-md text-center">
      {#if notFound}
        <h1 class="font-serif text-4xl font-light leading-none tracking-tight text-fg">
          We couldn't find that page<span class="text-accent">.</span>
        </h1>
        <p class="mt-4 text-sm text-fg/70">
          {isRecipient
            ? 'This link may have expired, or it may have been replaced by a newer one.'
            : "The link may be broken, or the page may have moved. Here's the way back."}
        </p>
      {:else}
        <h1 class="font-serif text-4xl font-light leading-none tracking-tight text-fg">
          Something went wrong<span class="text-accent">.</span>
        </h1>
        <p class="mt-4 text-sm text-fg/70">
          {detail}{worthRetrying ? ' Please try again in a moment.' : ''}
        </p>
      {/if}

      {#if isRecipient}
        <!-- Someone who was sent a link, not a user of the app. Every action the
             signed-in branch offers would bounce them to /sign-in, so the only
             honest thing to say is who can help: the person who sent it. -->
        <p class="mt-6 text-sm leading-relaxed text-fg/60">
          If someone sent you this link, ask them to send it again. Links can expire, and a
          replacement takes them a moment.
        </p>
      {:else}
        <div class="mt-8">
          <a href="/" class="btn">Back to dashboard</a>
        </div>

        {#if notFound}
          <nav
            class="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 font-mono text-xs uppercase tracking-widest text-fg/50"
          >
            <a href="/invoices" class="hover:text-fg">Invoices</a>
            <a href="/estimates" class="hover:text-fg">Estimates</a>
            <a href="/expenses" class="hover:text-fg">Expenses</a>
            <a href="/contacts" class="hover:text-fg">Contacts</a>
            <a href="/reports" class="hover:text-fg">Reports</a>
          </nav>
        {/if}
      {/if}
    </div>
  </main>
</div>

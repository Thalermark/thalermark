<script lang="ts">
  import { page } from '$app/state';

  // Root error boundary — the branded replacement for SvelteKit's default error
  // page. Renders for unmatched routes (404: a signed-in user who mistyped a URL;
  // signed-out visitors are redirected to /sign-in by the appHandle before ever
  // reaching here) and for genuine faults (500). 404s are expected errors and are
  // NOT reported to GlitchTip — handleError only reports unexpected ones — so this
  // is purely the user-facing page. The root layout is bare (just app.css), so
  // this page carries its own wordmark + centering, like the (auth) layout.
  const notFound = $derived(page.status === 404);
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
          The link may be broken, or the page may have moved. Here's the way back.
        </p>
      {:else}
        <h1 class="font-serif text-4xl font-light leading-none tracking-tight text-fg">
          Something went wrong<span class="text-accent">.</span>
        </h1>
        <p class="mt-4 text-sm text-fg/70">
          {page.error?.message ?? 'An unexpected error occurred.'} Please try again in a moment.
        </p>
      {/if}

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
    </div>
  </main>
</div>

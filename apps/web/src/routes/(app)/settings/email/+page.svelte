<script lang="ts">
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();

  // Show the just-saved value back on the form after an action, else the
  // stored value from load. Empty string renders as a cleared field.
  const value = $derived(form?.replyToEmail ?? data.company.replyToEmail ?? '');
</script>

<h1 class="font-serif text-4xl font-light leading-none tracking-tight text-ink">
  Email<span class="text-gold-deep">.</span>
</h1>

<section class="mt-8 rounded-sm border border-ink/15 bg-cream-warm">
  <header class="border-b border-ink/10 px-6 py-5">
    <span class="eyebrow">Reply-to address</span>
    <p class="mt-2 font-serif text-lg text-ink">{data.company.name}</p>
  </header>
  <form method="POST" action="?/save" class="px-6 py-6">
    <input type="hidden" name="companyId" value={data.company.id} />
    <p class="text-sm text-ink/70">
      Invoices and estimates go out under your business name, but from Thalermark's sending address.
      Set a reply-to so when a customer hits "reply," it reaches you. Leave it blank to send with no
      reply-to.
    </p>
    <label class="mt-5 block">
      <span class="font-mono text-xs uppercase tracking-widest text-ink/50">Reply-to email</span>
      <input
        type="email"
        name="replyToEmail"
        {value}
        placeholder="you@yourbusiness.com"
        class="mt-2 w-full max-w-md rounded-sm border border-ink/20 bg-cream px-3 py-2 text-sm text-ink focus:border-gold-deep focus:outline-none"
      />
    </label>
    <div class="mt-5 flex items-center gap-4">
      <button
        type="submit"
        class="rounded-sm bg-ink px-4 py-2 text-sm font-medium text-cream transition-colors hover:bg-gold-deep"
      >
        Save
      </button>
      {#if form?.saved}
        <span class="text-sm text-ink/60">Saved.</span>
      {:else if form?.error}
        <span class="text-sm text-rose-700">Couldn't save: {form.error}</span>
      {/if}
    </div>
  </form>
</section>

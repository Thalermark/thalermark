<script lang="ts">
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();

  // Show the just-saved value back on the form after an action, else the
  // stored value from load. Empty string renders as a cleared field.
  const value = $derived(form?.replyToEmail ?? data.company.replyToEmail ?? '');

  const TEMPLATE_LABELS: Record<string, string> = {
    invoice: 'Invoice',
    estimate: 'Estimate',
    statement: 'Customer statement',
  };
</script>

<h1 class="font-serif text-4xl font-light leading-none tracking-tight text-fg">
  Email<span class="text-accent">.</span>
</h1>

<section class="mt-8 rounded-sm border border-fg/15 bg-surface-2">
  <header class="border-b border-fg/10 px-6 py-5">
    <span class="eyebrow">Reply-to address</span>
    <p class="mt-2 font-serif text-lg text-fg">{data.company.name}</p>
  </header>
  <form method="POST" action="?/save" class="px-6 py-6">
    <input type="hidden" name="companyId" value={data.company.id} />
    <p class="text-sm text-fg/70">
      Invoices and estimates go out under your business name, but from Thalermark's sending address.
      Set a reply-to so when a customer hits "reply," it reaches you. Leave it blank to send with no
      reply-to.
    </p>
    <label class="mt-5 block">
      <span class="label">Reply-to email</span>
      <input
        type="email"
        name="replyToEmail"
        {value}
        placeholder="you@yourbusiness.com"
        class="mt-2 w-full max-w-md rounded-sm border border-fg/20 bg-surface px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
      />
    </label>
    <div class="mt-5 flex items-center gap-4">
      <button
        type="submit"
        class="btn"
      >
        Save
      </button>
      {#if form?.saved}
        <span class="text-sm text-fg/60">Saved.</span>
      {:else if form?.error}
        <span class="text-sm text-danger">Couldn't save: {form.error}</span>
      {/if}
    </div>
  </form>
</section>

<section class="mt-8 rounded-sm border border-fg/15 bg-surface-2">
  <header class="border-b border-fg/10 px-6 py-5">
    <span class="eyebrow">Email templates</span>
    <p class="mt-2 text-sm text-fg/70">
      Customize the wording your customers see. The Thalermark layout, buttons, and footer stay the
      same — you edit the subject and message.
    </p>
  </header>
  <ul class="divide-y divide-fg/10">
    {#each data.templates as tpl (tpl.type)}
      <li class="flex items-center justify-between gap-4 px-6 py-4">
        <div>
          <p class="font-serif text-lg text-fg">{TEMPLATE_LABELS[tpl.type] ?? tpl.type}</p>
          <span
            class="mt-1 inline-block rounded-sm px-2 py-0.5 font-mono text-[0.65rem] uppercase tracking-widest {tpl.isCustomized
              ? 'bg-accent/15 text-accent'
              : 'bg-fg/10 text-fg/60'}"
          >
            {tpl.isCustomized ? 'Customized' : 'Default'}
          </span>
        </div>
        <a href="/settings/email/{tpl.type}" class="btn-ghost btn-sm">Edit</a>
      </li>
    {/each}
  </ul>
</section>

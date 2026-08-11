<script lang="ts">
  import { enhance } from '$app/forms';
  import { enhanceForm } from '$lib/form-enhance';
    import { page } from '$app/state';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();

  const LABELS: Record<string, string> = {
    invoice: 'Invoice',
    estimate: 'Estimate',
    statement: 'Customer statement',
    reminder: 'Payment reminder',
  };

  const PLACEHOLDER_HELP: Record<string, string> = {
    customer_name: "the customer's name",
    invoice_number: 'invoice number',
    estimate_number: 'estimate number',
    amount: 'total amount, e.g. $1,500.00',
    // Deliberately worded to contrast with `amount` above. A reminder chases
    // what is STILL OWED — after any deposit — and the two stop being the same
    // number the moment a customer pays part of an invoice (TMC-189).
    outstanding: 'amount still owed, after any payments',
    due_date: 'invoice due date',
    statement_date: 'statement date',
    balance_due: 'balance owed',
    company_name: 'your business name',
  };

  const label = $derived(LABELS[data.type] ?? data.type);
  // Show the just-submitted values after an action (preview/error), else the
  // stored/effective copy from load.
  const subject = $derived(form?.subject ?? data.template.subject);
  const body = $derived(form?.body ?? data.template.body);
  const saved = $derived(page.url.searchParams.has('saved'));
  const reset = $derived(page.url.searchParams.has('reset'));
  const preview = $derived(form && 'preview' in form ? form.preview : null);
</script>

<div class="flex items-center justify-between gap-4">
  <h1 class="font-serif text-4xl font-light leading-none tracking-tight text-fg">
    {label} email<span class="text-accent">.</span>
  </h1>
  <a href="/settings/email" class="link text-sm">← All templates</a>
</div>

<p class="mt-3 text-sm text-fg/70">
  Edit the subject and message your contacts see. The Thalermark layout, button, and footer stay
  the same. Use the placeholders below — they're filled in for each {data.type} you send.
</p>

{#if saved}
  <p class="mt-4 callout text-sm">Saved. This template is now customized.</p>
{:else if reset}
  <p class="mt-4 callout text-sm">Reset to the default wording.</p>
{/if}

<section class="mt-6 rounded-sm border border-fg/15 bg-surface-2">
  <header class="flex items-center justify-between gap-4 border-b border-fg/10 px-6 py-5">
    <p class="font-serif text-lg text-fg">{data.company.name}</p>
    <span
      class="rounded-sm px-2 py-0.5 font-mono text-[0.65rem] uppercase tracking-widest {data.template
        .isCustomized
        ? 'bg-accent/15 text-accent'
        : 'bg-fg/10 text-fg/60'}"
    >
      {data.template.isCustomized ? 'Customized' : 'Default'}
    </span>
  </header>

  <form method="POST" class="px-6 py-6" use:enhance={enhanceForm}>
    <input type="hidden" name="companyId" value={data.company.id} />

    <label class="block">
      <span class="label">Subject</span>
      <input
        type="text"
        name="subject"
        value={subject}
        class="mt-2 w-full rounded-sm border border-fg/20 bg-surface px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
      />
    </label>

    <label class="mt-5 block">
      <span class="label">Message</span>
      <textarea
        name="body"
        rows="7"
        value={body}
        class="mt-2 w-full rounded-sm border border-fg/20 bg-surface px-3 py-2 font-mono text-sm leading-relaxed text-fg focus:border-accent focus:outline-none"
      ></textarea>
    </label>

    <div class="mt-4">
      <span class="label">Placeholders</span>
      <div class="mt-2 flex flex-wrap gap-2">
        {#each data.template.placeholders as p (p)}
          <span class="rounded-sm bg-fg/5 px-2 py-1 font-mono text-xs text-fg/70">
            {'{{'}{p}{'}}'}<span class="text-fg/40"> — {PLACEHOLDER_HELP[p] ?? p}</span>
          </span>
        {/each}
      </div>
    </div>

    {#if form?.error}
      <p class="mt-4 text-sm text-danger">{form.error}</p>
    {/if}

    <div class="mt-6 flex items-center gap-3">
      <button type="submit" formaction="?/save" class="btn">Save</button>
      <button type="submit" formaction="?/preview" class="btn-ghost">Preview</button>
    </div>
  </form>
</section>

{#if preview}
  <section class="mt-6 rounded-sm border border-fg/15 bg-surface-2">
    <header class="border-b border-fg/10 px-6 py-4">
      <span class="eyebrow">Preview</span>
      <p class="mt-2 text-sm text-fg/70">
        Subject: <span class="text-fg">{preview.subject}</span>
      </p>
    </header>
    <iframe
      title="Email preview"
      srcdoc={preview.html}
      sandbox=""
      class="h-[32rem] w-full rounded-b-sm bg-white"
    ></iframe>
  </section>
{/if}

{#if data.template.isCustomized}
  <form method="POST" action="?/reset" class="mt-6">
    <input type="hidden" name="companyId" value={data.company.id} />
    <button type="submit" class="link text-sm text-danger">Reset to default wording</button>
  </form>
{/if}

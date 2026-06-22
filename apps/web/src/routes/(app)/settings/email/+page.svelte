<script lang="ts">
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();

  const TEMPLATE_LABELS: Record<string, string> = {
    invoice: 'Invoice',
    estimate: 'Estimate',
    statement: 'Customer statement',
  };

  // After a "View" action, render the chosen template's preview inline under its
  // row (one at a time). Other actions (reply-to save) leave these null.
  const viewType = $derived(form && 'viewType' in form ? form.viewType : null);
  const viewHtml = $derived(form && 'viewHtml' in form ? form.viewHtml : null);
  const viewSubject = $derived(form && 'viewSubject' in form ? form.viewSubject : null);
  const viewError = $derived(form && 'viewError' in form ? form.viewError : null);
</script>

<h1 class="font-serif text-4xl font-light leading-none tracking-tight text-fg">
  Email templates<span class="text-accent">.</span>
</h1>
<p class="mt-4 max-w-prose text-sm leading-relaxed text-fg/70">
  Customize the wording your customers see. The Thalermark layout, buttons, and footer stay the same
  — you edit the subject and message.
</p>

<section class="mt-8 rounded-sm border border-fg/15 bg-surface-2">
  <ul class="divide-y divide-fg/10">
    {#each data.templates as tpl (tpl.type)}
      {@const isOpen = viewType === tpl.type}
      <li class="px-6 py-4">
        <div class="flex items-center justify-between gap-4">
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
          <div class="flex items-center gap-2">
            <form method="POST" action={isOpen ? '?/close' : '?/view'}>
              <input type="hidden" name="companyId" value={data.company.id} />
              <input type="hidden" name="type" value={tpl.type} />
              <button type="submit" class="btn-ghost btn-sm">{isOpen ? 'Close' : 'View'}</button>
            </form>
            <a href="/settings/email/{tpl.type}" class="btn-ghost btn-sm">Edit</a>
          </div>
        </div>
        {#if isOpen}
          {#if viewHtml}
            <div class="mt-4 overflow-hidden rounded-sm border border-fg/15 bg-surface">
              <p class="border-b border-fg/10 px-4 py-2 text-sm text-fg/70">
                Subject: <span class="text-fg">{viewSubject}</span>
              </p>
              <iframe
                title="{TEMPLATE_LABELS[tpl.type] ?? tpl.type} email preview"
                srcdoc={viewHtml}
                sandbox=""
                class="h-[28rem] w-full bg-white"
              ></iframe>
            </div>
          {:else if viewError}
            <p class="mt-3 text-sm text-danger">Couldn't load preview: {viewError}</p>
          {/if}
        {/if}
      </li>
    {/each}
  </ul>
</section>

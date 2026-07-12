<script lang="ts">
  import { page } from '$app/state';
  import { may } from '$lib/perms';

  // Static page — the download is a plain GET link to the +server.ts endpoint,
  // which streams the ZIP. Format is chosen client-side and appended to the URL;
  // CSV is the default. reports:export is enforced by the API, but we also gate
  // the button so a non-permitted role sees a note instead of a 403.
  let format = $state<'csv' | 'json'>('csv');
  const canExport = $derived(may(page.data.role, 'reports:export'));
  const href = $derived(`/settings/export/download?format=${format}`);
</script>

<h1 class="font-serif text-4xl font-light leading-none tracking-tight text-fg">
  Export<span class="text-accent">.</span>
</h1>

<section class="mt-8 rounded-sm border border-fg/15 bg-surface-2">
  <header class="border-b border-fg/10 px-6 py-5">
    <span class="eyebrow">Your data</span>
    <p class="mt-2 text-sm text-fg/70">
      Download every record in this workspace — invoices, estimates, expenses, bills, contacts,
      items, and more — as a single ZIP, with one folder per company. Your data is yours to keep or
      take elsewhere. Choose <strong>CSV</strong> to open the files in a spreadsheet, or
      <strong>JSON</strong> for an exact copy with invoice line items nested. Contacts and items re-import
      cleanly through the <a class="link" href="/settings/import">Import</a> tab.
    </p>
  </header>

  {#if canExport}
    <div class="grid gap-6 px-6 py-6">
      <fieldset class="grid gap-3">
        <legend class="label mb-1">Format</legend>
        <label class="flex items-center gap-3 text-sm text-fg">
          <input
            type="radio"
            bind:group={format}
            value="csv"
            class="size-4 border-fg/30 text-accent focus:ring-accent"
          />
          CSV — spreadsheet-friendly (Excel, Google Sheets)
        </label>
        <label class="flex items-center gap-3 text-sm text-fg">
          <input
            type="radio"
            bind:group={format}
            value="json"
            class="size-4 border-fg/30 text-accent focus:ring-accent"
          />
          JSON — exact copy, line items nested
        </label>
      </fieldset>
      <div>
        <a {href} class="btn" download>Download ZIP</a>
      </div>
    </div>
  {:else}
    <div class="px-6 py-6 text-sm text-fg/70">
      You don't have permission to export this workspace's data. Ask an owner or admin.
    </div>
  {/if}
</section>

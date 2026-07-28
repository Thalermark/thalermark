<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import { enhance } from '$app/forms';
  import {
    type ImportEntity,
    type ImportEntityKey,
    IMPORT_ENTITIES,
    autoMap,
    entityByKey,
  } from '$lib/import/descriptors';
  import StartingBalances from '$lib/components/StartingBalances.svelte';
  import type { OpeningBalanceForm } from '$lib/opening-balance';
  import { may } from '$lib/perms';

  import Papa from 'papaparse';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();

  // This page now runs two unrelated actions — the CSV import, and the three
  // starting-balance ones. Hand the component only its own result, or an import
  // error would render as a starting-balances error.
  const balanceForm = $derived(
    form && ('fieldErrors' in form || 'formError' in form || 'fullError' in form || 'values' in form)
      ? (form as OpeningBalanceForm)
      : null,
  );

  // Export half of the page. The download is a plain GET to the +server.ts
  // endpoint, which streams the ZIP; format is appended to the URL.
  // reports:export is enforced by the API — the gate here just shows a note
  // instead of letting someone walk into a 403.
  let exportFormat = $state<'csv' | 'json'>('csv');
  const canExport = $derived(may(page.data.role, 'reports:export'));
  const exportHref = $derived(`/settings/export/download?format=${exportFormat}`);

  // Only offer entities the role can actually create (the API gate is the real
  // authority; this just keeps the UI honest).
  const entities = $derived(IMPORT_ENTITIES.filter((e) => may(page.data.role, e.cap)));

  // Seed the active entity from ?entity= (the list pages link here pre-selected)
  // but only when it's a real key the role can create — a bad or forbidden param
  // must never select a hidden entity. Falls back to the first permitted entity
  // (today's default). Runs once at init; the picker drives it thereafter.
  function initialEntity(): ImportEntityKey {
    const wanted = page.url.searchParams.get('entity');
    if (wanted && entities.some((e) => e.key === wanted)) return wanted as ImportEntityKey;
    return entities[0]?.key ?? 'contacts';
  }
  let entityKey = $state<ImportEntityKey>(initialEntity());
  const entity = $derived<ImportEntity>(entityByKey(entityKey));

  let fileName = $state('');
  let headers = $state<string[]>([]);
  let dataRows = $state<string[][]>([]);
  let mapping = $state<Record<string, string>>({});
  let includeDupes = $state(false);
  let parseError = $state('');
  let submitting = $state(false);
  // The action's success result lives on `form` until the next navigation, so a
  // local flag lets "Import another file" dismiss the result screen and return
  // to the upload UI. Cleared on each fresh submit so a new result shows.
  let dismissed = $state(false);

  const showResult = $derived(form?.created !== undefined && !dismissed);
  const hasFile = $derived(headers.length > 0);
  const existingSet = $derived(
    new Set(entityKey === 'contacts' ? data.existing.contacts : data.existing.items),
  );

  function reset() {
    headers = [];
    dataRows = [];
    mapping = {};
    fileName = '';
    parseError = '';
    includeDupes = false;
  }

  function selectEntity(key: ImportEntityKey) {
    if (key === entityKey) return;
    entityKey = key;
    reset();
  }

  async function onFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    fileName = file.name;
    parseError = '';
    const txt = await file.text();
    const result = Papa.parse<string[]>(txt, { skipEmptyLines: 'greedy' });
    const all = result.data.filter((r) => r.some((c) => String(c).trim() !== ''));
    if (all.length < 2) {
      headers = [];
      dataRows = [];
      mapping = {};
      parseError = 'The file needs a header row and at least one data row.';
      return;
    }
    headers = all[0].map((h) => String(h).trim());
    dataRows = all.slice(1);
    mapping = autoMap(entity, headers);
  }

  type Preview = {
    index: number;
    status: 'ready' | 'duplicate' | 'error';
    error?: string;
    value?: Record<string, unknown>;
  };

  const preview = $derived.by<Preview[]>(() => {
    const seen = new Set<string>();
    const out: Preview[] = [];
    for (let i = 0; i < dataRows.length; i++) {
      const raw = dataRows[i];
      const obj: Record<string, unknown> = {};
      for (const f of entity.fields) {
        const header = mapping[f.key];
        if (!header) continue;
        const col = headers.indexOf(header);
        const cell = col >= 0 ? (raw[col] ?? '') : '';
        const coerced = f.coerce(String(cell));
        if (coerced !== undefined) obj[f.key] = coerced;
      }
      const res = entity.validateRow(obj);
      if (!res.ok) {
        out.push({ index: i, status: 'error', error: res.error });
        continue;
      }
      const key = entity.dupeKey(res.value);
      const dupe = key !== null && (existingSet.has(key) || seen.has(key));
      if (key) seen.add(key);
      out.push({ index: i, status: dupe ? 'duplicate' : 'ready', value: res.value });
    }
    return out;
  });

  const counts = $derived.by(() => {
    let ready = 0;
    let duplicate = 0;
    let error = 0;
    for (const r of preview) {
      if (r.status === 'ready') ready++;
      else if (r.status === 'duplicate') duplicate++;
      else error++;
    }
    return { ready, duplicate, error };
  });

  // Rows actually sent: ready always; duplicates only if the user opts in; never
  // the validation failures.
  const toImport = $derived(
    preview
      .filter((r) => r.status === 'ready' || (includeDupes && r.status === 'duplicate'))
      .map((r) => r.value as Record<string, unknown>),
  );

  const nameMapped = $derived(Boolean(mapping.name));
  const mappedFields = $derived(entity.fields.filter((f) => mapping[f.key]));

  function statusLabel(s: Preview['status']): string {
    return s === 'ready' ? 'Ready' : s === 'duplicate' ? 'May exist' : 'Error';
  }

  async function importAnother() {
    dismissed = true;
    reset();
    await invalidateAll();
  }
</script>

<span class="eyebrow">Settings</span>
<h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-fg">
  Import &amp; export<span class="text-accent">.</span>
</h1>
<p class="mt-3 max-w-prose text-sm text-fg/60">
  Getting your data in and out — the books you arrived with, your contacts and items, and a copy of
  everything to take away.
</p>

<section class="mt-12 border-t border-fg/10 pt-8">
  <h2 class="font-serif text-2xl font-light text-fg">Contacts &amp; items</h2>
  <p class="mt-2 max-w-prose text-sm text-fg/60">
    Bring in your existing contacts and items from a CSV — a spreadsheet export, or a download from
    another tool. Upload the file, line up the columns, and review before anything is saved.
  </p>
</section>

{#if !data.companyId}
  <div class="callout mt-8">Pick a company from the switcher before importing.</div>
{:else if entities.length === 0}
  <div class="callout mt-8">Your role can't create contacts or items, so there's nothing to import.</div>
{:else if showResult}
  {@const done = entityByKey((form?.entity as ImportEntityKey) ?? 'contacts')}
  <div class="mt-8 rounded-sm border border-success/30 bg-success/5 px-5 py-4">
    <p class="text-fg">
      Imported <strong>{form?.created}</strong>
      {form?.created === 1 ? done.label.toLowerCase().replace(/s$/, '') : done.label.toLowerCase()}.
    </p>
    <div class="mt-4 flex items-center gap-4">
      <a href={done.href} class="btn">View {done.label.toLowerCase()}</a>
      <button type="button" class="link text-sm" onclick={importAnother}>Import another file</button>
    </div>
  </div>
{:else}
  {#if form?.error}
    <div class="mt-8 rounded-sm border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
      {form.error}
    </div>
  {/if}

  <!-- Entity picker -->
  <div class="mt-8 flex gap-2">
    {#each entities as e (e.key)}
      <button
        type="button"
        onclick={() => selectEntity(e.key)}
        class="rounded-sm border px-4 py-2 text-sm transition-colors {entityKey === e.key
          ? 'border-accent bg-accent/10 text-fg'
          : 'border-fg/15 text-fg/60 hover:text-fg'}"
      >
        {e.label}
      </button>
    {/each}
  </div>

  <!-- Upload -->
  <div class="mt-6">
    <label for="csv" class="label">CSV file</label>
    <input
      id="csv"
      type="file"
      accept=".csv,text/csv"
      onchange={onFile}
      class="mt-1 block w-full text-sm text-fg/70 file:mr-4 file:rounded-sm file:border-0 file:bg-surface-2 file:px-4 file:py-2 file:text-sm file:text-fg hover:file:bg-surface-2/70"
    />
    {#if fileName}
      <p class="mt-1 text-xs text-fg/50">{fileName} — {dataRows.length} row{dataRows.length === 1 ? '' : 's'}</p>
    {/if}
    {#if parseError}
      <p class="mt-1 text-xs text-danger">{parseError}</p>
    {/if}
  </div>

  {#if hasFile}
    <!-- Column mapping -->
    <section class="mt-10">
      <h2 class="font-serif text-2xl font-light text-fg">Map columns</h2>
      <p class="mt-1 text-sm text-fg/60">
        We matched what we could. Set the rest, or leave a field as “Don't import”.
      </p>
      <div class="mt-4 grid gap-3 sm:grid-cols-2">
        {#each entity.fields as f (f.key)}
          <div class="flex items-center gap-3">
            <span class="w-40 shrink-0 text-sm text-fg/70">
              {f.label}{#if f.required}<span class="text-accent">*</span>{/if}
            </span>
            <select bind:value={mapping[f.key]} class="field">
              <option value="">— Don't import —</option>
              {#each headers as h (h)}
                <option value={h}>{h}</option>
              {/each}
            </select>
          </div>
        {/each}
      </div>
      {#if !nameMapped}
        <p class="mt-3 text-xs text-danger">Map a column to <strong>Name</strong> — it's required.</p>
      {/if}
    </section>

    <!-- Preview -->
    <section class="mt-10">
      <h2 class="font-serif text-2xl font-light text-fg">Preview</h2>
      <p class="mt-2 text-sm text-fg/70">
        <strong class="text-fg">{counts.ready}</strong> ready
        {#if counts.duplicate > 0}· <strong class="text-fg">{counts.duplicate}</strong> may already exist{/if}
        {#if counts.error > 0}· <strong class="text-danger">{counts.error}</strong> with errors (skipped){/if}
      </p>

      {#if counts.duplicate > 0}
        <label class="mt-3 flex items-center gap-2 text-sm text-fg/70">
          <input type="checkbox" bind:checked={includeDupes} />
          Import the {counts.duplicate} possible duplicate{counts.duplicate === 1 ? '' : 's'} anyway
        </label>
      {/if}

      <div class="mt-4 overflow-x-auto rounded-sm border border-fg/15">
        <table class="w-full text-sm">
          <thead class="bg-surface-2 text-left text-xs uppercase tracking-wide text-fg/50">
            <tr>
              <th class="px-3 py-2 font-medium">Status</th>
              {#each mappedFields as f (f.key)}
                <th class="px-3 py-2 font-medium">{f.label}</th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each preview.slice(0, 12) as row (row.index)}
              <tr class="border-t border-fg/10">
                <td class="whitespace-nowrap px-3 py-2">
                  <span
                    class="rounded-sm px-1.5 py-0.5 text-xs {row.status === 'ready'
                      ? 'bg-success/10 text-success'
                      : row.status === 'duplicate'
                        ? 'bg-warning/10 text-warning'
                        : 'bg-danger/10 text-danger'}"
                  >
                    {statusLabel(row.status)}
                  </span>
                </td>
                {#each mappedFields as f (f.key)}
                  <td class="px-3 py-2 text-fg/80">
                    {#if row.status === 'error' && f.key === 'name'}
                      <span class="text-danger">{row.error}</span>
                    {:else}
                      {row.value?.[f.key] ?? ''}
                    {/if}
                  </td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if preview.length > 12}
        <p class="mt-2 text-xs text-fg/50">Showing the first 12 of {preview.length} rows.</p>
      {/if}

      <!-- Submit -->
      <form
        method="post"
        action="?/import"
        class="mt-6"
        use:enhance={() => {
          submitting = true;
          dismissed = false;
          return async ({ update }) => {
            submitting = false;
            await update();
          };
        }}
      >
        <input type="hidden" name="entity" value={entityKey} />
        <input type="hidden" name="companyId" value={data.companyId} />
        <input type="hidden" name="rows" value={JSON.stringify(toImport)} />
        <button type="submit" class="btn" disabled={submitting || toImport.length === 0}>
          {submitting ? 'Importing…' : `Import ${toImport.length} ${entity.label.toLowerCase()}`}
        </button>
      </form>
    </section>
  {/if}
{/if}

<!-- Export. Lifted from the old /settings/export route so getting data in and
     getting it out sit together — the same job seen from both ends. -->
<section class="mt-12 border-t border-fg/10 pt-8">
  <h2 class="font-serif text-2xl font-light text-fg">Take a copy with you</h2>
  <p class="mt-2 max-w-prose text-sm text-fg/60">
    Download every record in this workspace — invoices, estimates, expenses, bills, contacts, items,
    and more — as a single ZIP, with one folder per company. Your data is yours to keep or take
    elsewhere. Contacts and items re-import cleanly through the section above.
  </p>

  {#if canExport}
    <div class="mt-5 grid max-w-2xl gap-5 rounded-sm border border-fg/10 bg-surface-2 p-5">
      <fieldset class="grid gap-3">
        <legend class="label mb-1">Format</legend>
        <label class="flex items-center gap-3 text-sm text-fg">
          <input
            type="radio"
            bind:group={exportFormat}
            value="csv"
            class="size-4 border-fg/30 text-accent focus:ring-accent"
          />
          CSV — spreadsheet-friendly (Excel, Google Sheets)
        </label>
        <label class="flex items-center gap-3 text-sm text-fg">
          <input
            type="radio"
            bind:group={exportFormat}
            value="json"
            class="size-4 border-fg/30 text-accent focus:ring-accent"
          />
          JSON — exact copy, line items nested
        </label>
      </fieldset>
      <div>
        <a href={exportHref} class="btn" download>Download ZIP</a>
      </div>
    </div>
  {:else}
    <p class="mt-5 text-sm text-fg/70">
      You don't have permission to export this workspace's data. Ask an owner or admin.
    </p>
  {/if}
</section>

<!-- Last, and the loudest thing on the page. Contacts and items are a
     convenience; this one has a deadline attached — someone who switched in
     July still files ONE return for the whole year, and if they don't enter
     what they already traded, their tax worksheet is short by however long they
     were somewhere else, with nothing on it to say so.
     The prominent heading asks the question, so the toggle inside the component
     is relabelled rather than repeating it. -->
{#if data.openingBalance}
  <section class="mt-14 border-t-2 border-accent/30 pt-8">
    <h2 class="font-serif text-3xl font-light leading-tight text-fg">
      Coming from other accounting software?
    </h2>
    <p class="mt-3 max-w-prose text-fg/70">
      Bring your books across — what your business owns, owes, and has already earned this year — so
      your numbers and your tax worksheet cover the whole year, not just the part you've spent here.
      Import a trial balance straight from QuickBooks, Xero or Wave.
    </p>

    <h3 class="label mt-8">Starting balances</h3>
    <p class="mt-2 max-w-prose text-sm text-fg/60">
      Where your business stood when you arrived. Just getting going? The three questions below are
      all you need.
    </p>
    <StartingBalances
      data={data.openingBalance}
      form={balanceForm}
      cancelHref="/settings/import"
      advancedLabel="I have a trial balance to enter"
    />
  </section>
{/if}

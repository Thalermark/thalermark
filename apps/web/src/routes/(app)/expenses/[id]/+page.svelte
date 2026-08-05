<script lang="ts">
  import AuditHistory from '$lib/components/AuditHistory.svelte';
  import { may } from '$lib/perms';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const e = $derived(data.expense);

  // Role gate (UX only — the API is authoritative). Every expense action here —
  // edit, duplicate, delete, and the receipt upload/extract/remove — is
  // `expenses:write` (held by owner/admin/member/accountant, not viewer).
  const canWrite = $derived(may(data.role, 'expenses:write'));

  // Job costing (TMC-174). The current answer to "what was this for?", as the
  // select's value: an invoice id, 'shared', or '' for never-answered. The API
  // models these as a row, a null-invoice row, and no rows respectively —
  // shared is a real answer, not a skipped question, which is why it is not the
  // same as ''.
  const currentTarget = $derived.by(() => {
    const allocations = e.allocations ?? [];
    if (allocations.length === 0) return '';
    if (allocations.length === 1 && allocations[0]?.invoiceId === null) return 'shared';
    return allocations[0]?.invoiceId ?? '';
  });
  // A split across several jobs can't be represented by the single-select, and
  // must never be silently flattened into "the first one" on save.
  const isSplit = $derived((e.allocations ?? []).length > 1);
</script>

<a href="/expenses" class="eyebrow text-fg/60 hover:text-fg">← Expenses</a>
<div class="mt-3 flex items-baseline justify-between gap-6">
  <h1 class="font-serif text-4xl font-light leading-none tracking-tight text-fg">
    {e.merchant}<span class="text-accent">.</span>
  </h1>
  {#if canWrite}
    <div class="flex items-center gap-3">
      <a
        href="/expenses/{e.id}/edit"
        class="rounded-sm border border-fg/20 px-3 py-1 font-mono text-xs uppercase tracking-widest text-fg/70 hover:border-accent hover:text-accent"
      >
        Edit
      </a>
      <!-- Duplicate-as-template: a plain link to the new-expense form seeded from
           this expense (date resets to today). The user reviews + saves — no
           server clone, so a duplicate never silently posts to the ledger. -->
      <a
        href="/expenses/new?duplicate={e.id}"
        class="rounded-sm border border-fg/20 px-3 py-1 font-mono text-xs uppercase tracking-widest text-fg/70 hover:border-accent hover:text-accent"
      >
        Duplicate
      </a>
      <form method="post" action="?/delete">
        <button
          type="submit"
          class="rounded-sm border border-danger/30 px-3 py-1 font-mono text-xs uppercase tracking-widest text-danger/80 hover:border-danger hover:text-danger"
        >
          Delete
        </button>
      </form>
    </div>
  {/if}
</div>

{#if form?.deleteError}
  <div class="mt-4 rounded-sm border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
    Could not delete this expense: {form.deleteError}
  </div>
{/if}
{#if form?.receiptError}
  <div class="mt-4 rounded-sm border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
    {form.receiptError}
  </div>
{/if}
{#if form?.extractError}
  <div class="mt-4 rounded-sm border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
    {form.extractError}
  </div>
{/if}
{#if form?.reviewError}
  <div class="mt-4 rounded-sm border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
    {form.reviewError}
  </div>
{/if}

<!-- Needs-review: a receipt landed with no vendor linked. Link one (via edit's
     Vendor field) or dismiss the flag (no contact created). -->
{#if e.vendorReview === 'needs_review' && canWrite}
  <div
    class="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-sm border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-fg/80"
  >
    <span>This expense has a receipt but no vendor linked yet.</span>
    <div class="flex items-center gap-4">
      <a
        href="/expenses/{e.id}/edit"
        class="rounded-sm border border-warning/40 px-3 py-1 font-mono text-xs uppercase tracking-widest text-warning hover:bg-warning/10"
      >
        Link a vendor
      </a>
      <form method="post" action="?/dismissReview">
        <button
          type="submit"
          class="font-mono text-xs uppercase tracking-widest text-fg/50 hover:text-fg"
        >
          Dismiss
        </button>
      </form>
    </div>
  </div>
{/if}

<dl class="mt-8 grid grid-cols-1 gap-x-12 gap-y-6 sm:grid-cols-2">
  <div>
    <dt class="label">Amount</dt>
    <dd class="mt-1 font-mono tabular-nums text-fg">{e.amount}</dd>
  </div>
  <div>
    <dt class="label">Date</dt>
    <dd class="mt-1 font-mono tabular-nums text-fg">{e.expenseDate}</dd>
  </div>
  <div>
    <dt class="label">Category</dt>
    <dd class="mt-1 text-fg">{data.categoryLabel}</dd>
  </div>
  <div>
    <dt class="label">Paid from</dt>
    <dd class="mt-1 text-fg">{data.paymentLabel}</dd>
  </div>
  {#if e.memo}
    <div class="sm:col-span-2">
      <dt class="label">Memo</dt>
      <dd class="mt-1 whitespace-pre-wrap text-fg/80">{e.memo}</dd>
    </div>
  {/if}
</dl>

<section class="mt-10">
  <h2 class="label">Receipt</h2>
  {#if data.receipt}
    <div class="mt-3 space-y-3">
      {#if data.receipt.contentType.startsWith('image/')}
        <img
          src={data.receipt.url}
          alt="Receipt for {e.merchant}"
          class="max-h-96 rounded-sm border border-fg/10 bg-surface-2"
        />
      {:else}
        <a
          href={data.receipt.url}
          target="_blank"
          rel="noopener"
          class="inline-block rounded-sm border border-fg/20 px-3 py-2 text-sm text-fg hover:border-accent hover:text-accent"
        >
          View receipt (PDF) →
        </a>
      {/if}
      {#if canWrite}
        <div class="flex flex-wrap items-center gap-4">
          <form method="post" action="?/extract">
            <button
              type="submit"
              class="rounded-sm border border-accent/40 px-3 py-1.5 text-sm text-accent hover:border-accent hover:bg-accent/5"
            >
              Auto-fill from receipt
            </button>
          </form>
          <form method="post" action="?/deleteReceipt">
            <button
              type="submit"
              class="text-xs uppercase tracking-widest text-danger/70 hover:text-danger"
            >
              Remove receipt
            </button>
          </form>
        </div>
      {/if}
    </div>
  {:else if canWrite}
    <form method="post" action="?/uploadReceipt" enctype="multipart/form-data" class="mt-3 flex flex-wrap items-center gap-3">
      <input
        type="file"
        name="file"
        accept="image/jpeg,image/png,application/pdf"
        required
        class="text-sm text-fg/80 file:mr-3 file:rounded-sm file:border-0 file:bg-inverse file:px-3 file:py-1.5 file:text-sm file:text-on-inverse hover:file:bg-accent"
      />
      <button
        type="submit"
        class="rounded-sm border border-fg/20 px-3 py-1.5 text-sm text-fg hover:border-accent hover:text-accent"
      >
        Upload
      </button>
      <span class="text-xs text-fg/50">JPEG, PNG, or PDF · up to 10 MB</span>
    </form>
  {:else}
    <p class="mt-3 text-sm text-fg/50">No receipt attached.</p>
  {/if}
</section>

<!--
  The one new question (TMC-174). Deliberately a single select and a save, not a
  wizard: one answer ends it. "Shared" is a first-class option, not a way of
  skipping — it means "several jobs, don't ask me to split it", and picking it
  never opens a follow-up.
-->
<section class="mt-10">
  <h2 class="label">What was this for?</h2>
  {#if isSplit}
    <p class="mt-2 text-sm text-fg/70">
      Split across {(e.allocations ?? []).length} jobs. Editing that split isn't here yet — the job
      report shows where it landed.
    </p>
  {:else if canWrite}
    <form method="post" action="?/setAllocation" class="mt-3 flex flex-wrap items-center gap-3">
      <select name="target" class="field max-w-sm" value={currentTarget}>
        <option value="">Not sure yet</option>
        <option value="shared">Shared across jobs</option>
        {#each data.jobs as job (job.id)}
          <option value={job.id}>
            {job.customerName ?? 'No name'} · {job.number} · {job.issueDate}
          </option>
        {/each}
      </select>
      <button
        type="submit"
        class="rounded-sm border border-fg/20 px-3 py-1.5 text-sm text-fg hover:border-accent hover:text-accent"
      >
        Save
      </button>
      {#if form?.allocationSaved}
        <span class="text-sm text-fg/60">Saved.</span>
      {/if}
      {#if form?.allocationError}
        <span class="text-sm text-danger">{form.allocationError}</span>
      {/if}
    </form>
    <p class="mt-2 text-xs text-fg/50">
      Tagging a job lets us tell you what that job made. It changes nothing about your books or
      your taxes.
    </p>
  {:else if currentTarget === 'shared'}
    <p class="mt-2 text-sm text-fg/70">Shared across jobs.</p>
  {:else if currentTarget}
    <p class="mt-2 text-sm text-fg/70">
      {data.jobs.find((j) => j.id === currentTarget)?.customerName ?? 'A job'}
    </p>
  {:else}
    <p class="mt-2 text-sm text-fg/50">Not tagged to a job.</p>
  {/if}
</section>

<AuditHistory events={data.auditEvents} />

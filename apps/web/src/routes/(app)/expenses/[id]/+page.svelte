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

<AuditHistory events={data.auditEvents} />

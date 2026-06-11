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

<a href="/expenses" class="eyebrow text-ink/60 hover:text-ink">← Expenses</a>
<div class="mt-3 flex items-baseline justify-between gap-6">
  <h1 class="font-serif text-4xl font-light leading-none tracking-tight text-ink">
    {e.merchant}<span class="text-gold-deep">.</span>
  </h1>
  {#if canWrite}
    <div class="flex items-center gap-3">
      <a
        href="/expenses/{e.id}/edit"
        class="rounded-sm border border-ink/20 px-3 py-1 font-mono text-xs uppercase tracking-widest text-ink/70 hover:border-gold-deep hover:text-gold-deep"
      >
        Edit
      </a>
      <!-- Duplicate-as-template: a plain link to the new-expense form seeded from
           this expense (date resets to today). The user reviews + saves — no
           server clone, so a duplicate never silently posts to the ledger. -->
      <a
        href="/expenses/new?duplicate={e.id}"
        class="rounded-sm border border-ink/20 px-3 py-1 font-mono text-xs uppercase tracking-widest text-ink/70 hover:border-gold-deep hover:text-gold-deep"
      >
        Duplicate
      </a>
      <form method="post" action="?/delete">
        <button
          type="submit"
          class="rounded-sm border border-oxblood/30 px-3 py-1 font-mono text-xs uppercase tracking-widest text-oxblood/80 hover:border-oxblood hover:text-oxblood"
        >
          Delete
        </button>
      </form>
    </div>
  {/if}
</div>

{#if form?.deleteError}
  <div class="mt-4 rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-3 text-sm text-oxblood">
    Could not delete this expense: {form.deleteError}
  </div>
{/if}
{#if form?.receiptError}
  <div class="mt-4 rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-3 text-sm text-oxblood">
    {form.receiptError}
  </div>
{/if}
{#if form?.extractError}
  <div class="mt-4 rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-3 text-sm text-oxblood">
    {form.extractError}
  </div>
{/if}

<dl class="mt-8 grid grid-cols-1 gap-x-12 gap-y-6 sm:grid-cols-2">
  <div>
    <dt class="font-mono text-xs uppercase tracking-widest text-ink/50">Amount</dt>
    <dd class="mt-1 font-mono tabular-nums text-ink">{e.amount}</dd>
  </div>
  <div>
    <dt class="font-mono text-xs uppercase tracking-widest text-ink/50">Date</dt>
    <dd class="mt-1 font-mono tabular-nums text-ink">{e.expenseDate}</dd>
  </div>
  <div>
    <dt class="font-mono text-xs uppercase tracking-widest text-ink/50">Category</dt>
    <dd class="mt-1 text-ink">{data.categoryLabel}</dd>
  </div>
  <div>
    <dt class="font-mono text-xs uppercase tracking-widest text-ink/50">Paid from</dt>
    <dd class="mt-1 text-ink">{data.paymentLabel}</dd>
  </div>
  {#if e.memo}
    <div class="sm:col-span-2">
      <dt class="font-mono text-xs uppercase tracking-widest text-ink/50">Memo</dt>
      <dd class="mt-1 whitespace-pre-wrap text-ink/80">{e.memo}</dd>
    </div>
  {/if}
</dl>

<section class="mt-10">
  <h2 class="font-mono text-xs uppercase tracking-widest text-ink/50">Receipt</h2>
  {#if data.receipt}
    <div class="mt-3 space-y-3">
      {#if data.receipt.contentType.startsWith('image/')}
        <img
          src={data.receipt.url}
          alt="Receipt for {e.merchant}"
          class="max-h-96 rounded-sm border border-ink/10 bg-cream-warm"
        />
      {:else}
        <a
          href={data.receipt.url}
          target="_blank"
          rel="noopener"
          class="inline-block rounded-sm border border-ink/20 px-3 py-2 text-sm text-ink hover:border-gold-deep hover:text-gold-deep"
        >
          View receipt (PDF) →
        </a>
      {/if}
      {#if canWrite}
        <div class="flex flex-wrap items-center gap-4">
          <form method="post" action="?/extract">
            <button
              type="submit"
              class="rounded-sm border border-gold-deep/40 px-3 py-1.5 text-sm text-gold-deep hover:border-gold-deep hover:bg-gold-deep/5"
            >
              Auto-fill from receipt
            </button>
          </form>
          <form method="post" action="?/deleteReceipt">
            <button
              type="submit"
              class="text-xs uppercase tracking-widest text-oxblood/70 hover:text-oxblood"
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
        class="text-sm text-ink/80 file:mr-3 file:rounded-sm file:border-0 file:bg-ink file:px-3 file:py-1.5 file:text-sm file:text-cream hover:file:bg-gold-deep"
      />
      <button
        type="submit"
        class="rounded-sm border border-ink/20 px-3 py-1.5 text-sm text-ink hover:border-gold-deep hover:text-gold-deep"
      >
        Upload
      </button>
      <span class="text-xs text-ink/50">JPEG, PNG, or PDF · up to 10 MB</span>
    </form>
  {:else}
    <p class="mt-3 text-sm text-ink/50">No receipt attached.</p>
  {/if}
</section>

<AuditHistory events={data.auditEvents} />

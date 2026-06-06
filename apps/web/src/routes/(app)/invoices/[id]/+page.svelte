<script lang="ts">
  import AuditHistory from '$lib/components/AuditHistory.svelte';
  import PaymentFields from '$lib/components/PaymentFields.svelte';
  import SplitButton from '$lib/components/SplitButton.svelte';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const inv = $derived(data.invoice);
  const customer = $derived(data.customer);

  // Mirrors the API state machine: draft can be sent / paid / voided;
  // sent can be paid / voided; paid and voided are terminal. The buttons
  // disappear on terminal states so the UI doesn't tempt a 409 round-trip.
  // canSend covers both first-send (draft → sent + email) and resend
  // (sent → email only); the API handles the dispatch.
  const canSend = $derived(inv.status === 'draft' || inv.status === 'sent');
  const canMarkSent = $derived(inv.status === 'draft');
  const canMarkPaid = $derived(inv.status === 'draft' || inv.status === 'sent');
  const canVoid = $derived(inv.status === 'draft' || inv.status === 'sent');
  // Edit gate matches the API's draft-only rule — once sent/paid/voided the
  // invoice belongs to the audit trail, not the editor.
  const canEdit = $derived(inv.status === 'draft');
  const hasActions = $derived(canSend || canMarkSent || canMarkPaid || canVoid);

  // Public share URL is available once mark-sent mints the token. Built
  // server-side off event.url.origin so it works behind any proxy. Shown
  // alongside the email send so the user can also share the link directly.
  const publicUrl = $derived(inv.publicToken ? `${data.origin}/i/${inv.publicToken}` : null);

  // Send-form state: collapsed `to` override field, opens on a click.
  // Default `to` mirrors the customer's email when available.
  let showOverride = $state(false);
  const sendLabel = $derived(inv.status === 'sent' ? 'Resend invoice' : 'Send invoice');

  // How a paid invoice was settled. 'stripe' is the webhook-stamped channel;
  // the rest come from the manual mark-paid picker. Falls back to the raw code
  // for forward-compat if a new method lands before this map is updated.
  const PAYMENT_METHOD_LABELS: Record<string, string> = {
    cash: 'Cash',
    check: 'Check',
    venmo: 'Venmo',
    zelle: 'Zelle',
    stripe: 'Card (Stripe)',
    other: 'Other',
  };
  const paidVia = $derived(
    inv.status === 'paid' && inv.paymentMethod
      ? (PAYMENT_METHOD_LABELS[inv.paymentMethod] ?? inv.paymentMethod)
      : null,
  );

  // Mark-paid disclosure: the toolbar shows a single Mark paid button that
  // reveals a panel, rather than crowding the action row with a select + field.
  // paidMethod drives the conditional check-number input inside the panel.
  const PAID_METHOD_CHOICES = [
    { value: 'cash', label: 'Cash' },
    { value: 'check', label: 'Check' },
    { value: 'venmo', label: 'Venmo' },
    { value: 'zelle', label: 'Zelle' },
    { value: 'other', label: 'Other' },
  ] as const;
  let showPaidPanel = $state(false);
  // Editing the recorded payment on an already-paid invoice — reuses the same
  // PaymentFields, pre-filled. Any date change is an append-only ledger
  // correction handled server-side.
  const canEditPayment = $derived(inv.status === 'paid');
  let showEditPayment = $state(false);
</script>

<a href="/invoices" class="eyebrow text-ink/60 hover:text-ink">← Invoices</a>
<div class="mt-3 flex items-baseline justify-between gap-6">
  <h1 class="font-serif text-4xl font-light leading-none tracking-tight text-ink">
    Invoice {inv.number}<span class="text-gold-deep">.</span>
  </h1>
  <div class="flex items-center gap-3">
    {#if canEdit}
      <a
        href="/invoices/{inv.id}/edit"
        class="rounded-sm border border-ink/20 px-3 py-1 font-mono text-xs uppercase tracking-widest text-ink/70 hover:border-gold-deep hover:text-gold-deep"
      >
        Edit
      </a>
    {/if}
    <!-- Duplicate-as-template: available for any status (a paid/sent invoice is
         a common template). Posts to ?/duplicate → new draft's edit page. -->
    <form method="post" action="?/duplicate">
      <button
        type="submit"
        class="rounded-sm border border-ink/20 px-3 py-1 font-mono text-xs uppercase tracking-widest text-ink/70 hover:border-gold-deep hover:text-gold-deep"
      >
        Duplicate
      </button>
    </form>
    <span class="font-mono text-xs uppercase tracking-widest text-ink/60">{inv.status}</span>
  </div>
</div>

{#if form?.transitionError}
  <div class="mt-6 rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-3 text-sm text-oxblood">
    {form.transitionError}
  </div>
{/if}

{#if data.sentTo}
  <div class="mt-6 rounded-sm border border-gold-deep/30 bg-gold-deep/5 px-4 py-3 text-sm text-ink">
    Sent to <span class="font-medium">{data.sentTo}</span>.
  </div>
{/if}

{#if data.needsBusinessDetails && inv.status === 'draft' && data.businessCompanyId}
  <details class="mt-6 rounded-sm border border-gold-deep/30 bg-gold-deep/5 px-4 py-3 text-sm text-ink">
    <summary class="cursor-pointer list-none font-medium">
      Your business address won't show on this invoice yet.
      <span class="font-mono text-xs uppercase tracking-widest text-gold-deep">Add it →</span>
    </summary>
    <form method="post" action="?/addBusinessDetails" class="mt-4 space-y-4">
      <input type="hidden" name="companyId" value={data.businessCompanyId} />
      <p class="text-ink/70">
        Add it once and it appears on this invoice and every one after. You can skip and send
        without — set it later from Settings → Business.
      </p>
      <label class="block">
        <span class="font-mono text-xs uppercase tracking-widest text-ink/50">Business address</span>
        <textarea
          name="businessAddress"
          rows="3"
          placeholder="123 Main St&#10;Springfield, IL 62704"
          class="mt-2 w-full max-w-md rounded-sm border border-ink/20 bg-cream px-3 py-2 text-sm text-ink focus:border-gold-deep focus:outline-none"
        ></textarea>
      </label>
      <label class="block">
        <span class="font-mono text-xs uppercase tracking-widest text-ink/50">Phone (optional)</span>
        <input
          type="tel"
          name="businessPhone"
          placeholder="(555) 123-4567"
          class="mt-2 w-full max-w-md rounded-sm border border-ink/20 bg-cream px-3 py-2 text-sm text-ink focus:border-gold-deep focus:outline-none"
        />
      </label>
      <button
        type="submit"
        class="rounded-sm bg-ink px-4 py-2 text-sm font-medium text-cream transition-colors hover:bg-gold-deep"
      >
        Save &amp; continue
      </button>
    </form>
  </details>
{/if}

{#if hasActions}
  <div class="mt-6 flex flex-wrap items-center gap-3">
    {#if canSend}
      <form method="post" action="?/send" class="flex flex-wrap items-center gap-2">
        {#if showOverride}
          <input
            type="email"
            name="to"
            placeholder={customer?.email ?? 'recipient@example.com'}
            class="rounded-sm border border-ink/20 bg-cream-warm px-3 py-2 text-sm text-ink placeholder:text-ink/40 focus:border-gold-deep focus:outline-none"
          />
        {/if}
        <SplitButton label="Send options" caretClass="border-l border-cream/20 bg-ink text-cream hover:bg-gold-deep">
          {#snippet primary()}
            <button
              type="submit"
              class="rounded-l-sm bg-ink px-4 py-2 text-sm font-medium text-cream transition-colors hover:bg-gold-deep"
            >
              {sendLabel}
            </button>
          {/snippet}
          {#snippet menu(close)}
            <button
              type="button"
              role="menuitem"
              onclick={() => {
                showOverride = true;
                close();
              }}
              class="block w-full px-4 py-2 text-left text-sm text-ink/80 transition-colors hover:bg-cream-warm hover:text-ink"
            >
              Send to a different email…
            </button>
          {/snippet}
        </SplitButton>
      </form>
    {/if}
    {#if canMarkPaid}
      <SplitButton label="Payment method" caretClass="border border-ink/20 bg-cream-warm text-ink hover:border-gold-deep hover:text-gold-deep">
        {#snippet primary()}
          <button
            type="button"
            onclick={() => {
              showPaidPanel = !showPaidPanel;
            }}
            class="rounded-l-sm border border-r-0 border-ink/20 bg-cream-warm px-4 py-2 text-sm font-medium text-ink transition-colors hover:border-gold-deep hover:text-gold-deep"
          >
            Mark paid
          </button>
        {/snippet}
        {#snippet menu()}
          <p class="px-4 py-2 font-mono text-xs uppercase tracking-widest text-ink/40">
            Mark paid as…
          </p>
          <!-- Plain POST: the navigation itself dismisses the menu, so we must
               NOT close() on click — removing the form from the DOM first leaves
               it "not connected" and the browser cancels the submit. -->
          {#each PAID_METHOD_CHOICES as choice (choice.value)}
            <form method="post" action="?/markPaid">
              <input type="hidden" name="method" value={choice.value} />
              <button
                type="submit"
                role="menuitem"
                class="block w-full px-4 py-2 text-left text-sm text-ink/80 transition-colors hover:bg-cream-warm hover:text-ink"
              >
                {choice.label}
              </button>
            </form>
          {/each}
        {/snippet}
      </SplitButton>
    {/if}
    {#if canVoid}
      <form method="post" action="?/void">
        <button
          type="submit"
          class="rounded-sm border border-oxblood/30 px-4 py-2 text-sm font-medium text-oxblood transition-colors hover:bg-oxblood/5"
        >
          Void
        </button>
      </form>
    {/if}
  </div>
  {#if canMarkSent}
    <form method="post" action="?/markSent" class="mt-2">
      <button
        type="submit"
        class="text-xs uppercase tracking-widest text-ink/50 hover:text-gold-deep"
      >
        Mark sent without email
      </button>
    </form>
  {/if}

  {#if canMarkPaid && showPaidPanel}
    <form
      method="post"
      action="?/markPaid"
      class="mt-4 max-w-md rounded-sm border border-ink/15 bg-cream-warm p-5"
    >
      <PaymentFields />
      <div class="mt-5 flex items-center gap-3">
        <button
          type="submit"
          class="rounded-sm bg-ink px-4 py-2 text-sm font-medium text-cream transition-colors hover:bg-gold-deep"
        >
          Confirm paid
        </button>
        <button
          type="button"
          onclick={() => {
            showPaidPanel = false;
          }}
          class="text-xs uppercase tracking-widest text-ink/50 hover:text-gold-deep"
        >
          Cancel
        </button>
      </div>
    </form>
  {/if}
{/if}

{#if canEditPayment}
  <div class="mt-6">
    {#if !showEditPayment}
      <button
        type="button"
        onclick={() => {
          showEditPayment = true;
        }}
        class="rounded-sm border border-ink/20 px-3 py-1 font-mono text-xs uppercase tracking-widest text-ink/70 hover:border-gold-deep hover:text-gold-deep"
      >
        Edit payment
      </button>
    {:else}
      <form
        method="post"
        action="?/editPayment"
        class="max-w-md rounded-sm border border-ink/15 bg-cream-warm p-5"
      >
        <PaymentFields
          method={inv.paymentMethod ?? 'cash'}
          reference={inv.paymentReference}
          date={inv.paidAt ? inv.paidAt.slice(0, 10) : undefined}
        />
        <div class="mt-5 flex items-center gap-3">
          <button
            type="submit"
            class="rounded-sm bg-ink px-4 py-2 text-sm font-medium text-cream transition-colors hover:bg-gold-deep"
          >
            Update payment
          </button>
          <button
            type="button"
            onclick={() => {
              showEditPayment = false;
            }}
            class="text-xs uppercase tracking-widest text-ink/50 hover:text-gold-deep"
          >
            Cancel
          </button>
        </div>
      </form>
    {/if}
  </div>
{/if}

{#if publicUrl}
  <div class="mt-6 rounded-sm border border-ink/10 bg-cream-warm p-4">
    <p class="font-mono text-xs uppercase tracking-widest text-ink/50">Share link</p>
    <div class="mt-2 flex flex-wrap items-center gap-3 text-sm">
      <a href={publicUrl} target="_blank" rel="noopener" class="break-all text-gold-deep hover:underline">
        {publicUrl}
      </a>
    </div>
    <p class="mt-2 text-xs text-ink/50">
      Anyone with this link can view the invoice.
    </p>
  </div>
{/if}

<dl class="mt-8 grid grid-cols-1 gap-x-12 gap-y-6 sm:grid-cols-3">
  <div>
    <dt class="font-mono text-xs uppercase tracking-widest text-ink/50">Customer</dt>
    <dd class="mt-1 text-ink">
      {#if customer}
        <a href="/customers/{customer.id}" class="hover:text-gold-deep">{customer.name}</a>
      {:else}
        —
      {/if}
    </dd>
  </div>
  <div>
    <dt class="font-mono text-xs uppercase tracking-widest text-ink/50">Issued</dt>
    <dd class="mt-1 text-ink">{inv.issueDate}</dd>
  </div>
  <div>
    <dt class="font-mono text-xs uppercase tracking-widest text-ink/50">Due</dt>
    <dd class="mt-1 text-ink">{inv.dueDate}</dd>
  </div>
  {#if paidVia}
    <div>
      <dt class="font-mono text-xs uppercase tracking-widest text-ink/50">Paid via</dt>
      <dd class="mt-1 text-ink">
        {paidVia}{#if inv.paymentReference} · {inv.paymentReference}{/if}
      </dd>
    </div>
  {/if}
  {#if inv.status === 'paid' && inv.paidAt}
    <div>
      <dt class="font-mono text-xs uppercase tracking-widest text-ink/50">Paid on</dt>
      <dd class="mt-1 text-ink">{inv.paidAt.slice(0, 10)}</dd>
    </div>
  {/if}
</dl>

<div class="mt-10 overflow-hidden rounded-sm border border-ink/10 bg-cream-warm">
  <table class="w-full text-left text-sm">
    <thead class="bg-cream">
      <tr class="font-mono text-xs uppercase tracking-widest text-ink/50">
        <th class="px-5 py-3">Description</th>
        <th class="px-5 py-3 text-right">Qty</th>
        <th class="px-5 py-3 text-right">Unit price</th>
        <th class="px-5 py-3 text-right">Amount</th>
      </tr>
    </thead>
    <tbody class="divide-y divide-ink/10">
      {#each inv.lineItems as li (li.id)}
        <tr>
          <td class="px-5 py-4 text-ink">{li.description}</td>
          <td class="px-5 py-4 text-right font-mono tabular-nums text-ink/80">{li.quantity}</td>
          <td class="px-5 py-4 text-right font-mono tabular-nums text-ink/80">{li.unitPrice}</td>
          <td class="px-5 py-4 text-right font-mono tabular-nums text-ink">{li.amount}</td>
        </tr>
      {/each}
    </tbody>
    <tfoot class="bg-cream">
      <tr>
        <td colspan="3" class="px-5 py-3 text-right font-mono text-xs uppercase tracking-widest text-ink/50">
          Subtotal
        </td>
        <td class="px-5 py-3 text-right font-mono tabular-nums text-ink">{inv.subtotal}</td>
      </tr>
      <tr>
        <td colspan="3" class="px-5 py-3 text-right font-mono text-xs uppercase tracking-widest text-ink/50">
          Tax
        </td>
        <td class="px-5 py-3 text-right font-mono tabular-nums text-ink">{inv.tax}</td>
      </tr>
      <tr>
        <td colspan="3" class="px-5 py-3 text-right font-mono text-xs uppercase tracking-widest text-ink/50">
          Total ({inv.currency})
        </td>
        <td class="px-5 py-3 text-right font-mono tabular-nums text-lg text-ink">{inv.total}</td>
      </tr>
    </tfoot>
  </table>
</div>

{#if inv.notes}
  <div class="mt-8">
    <h2 class="font-mono text-xs uppercase tracking-widest text-ink/50">Notes</h2>
    <p class="mt-2 whitespace-pre-wrap text-ink/80">{inv.notes}</p>
  </div>
{/if}

<AuditHistory events={data.auditEvents} />

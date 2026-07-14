<script lang="ts">
  import AuditHistory from '$lib/components/AuditHistory.svelte';
  import PaymentFields from '$lib/components/PaymentFields.svelte';
  import SplitButton from '$lib/components/SplitButton.svelte';
  import { may } from '$lib/perms';
  import { formatUnitPrice } from '@thalermark/validation';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const inv = $derived(data.invoice);
  const contact = $derived(data.contact);

  // Role gate (UX only — the API is authoritative). All invoice writes and
  // state actions are `sales:write`; the inline "add business address" shortcut
  // edits the company, so it needs `settings:manage`. Each status gate below is
  // ANDed with canWrite so a viewer/accountant sees no action buttons at all.
  const canWrite = $derived(may(data.role, 'sales:write'));
  const canManageSettings = $derived(may(data.role, 'settings:manage'));

  // Mirrors the API state machine: draft can be sent / paid / voided;
  // sent can be paid / voided; paid and voided are terminal. The buttons
  // disappear on terminal states so the UI doesn't tempt a 409 round-trip.
  // canSend covers both first-send (draft → sent + email) and resend
  // (sent → email only); the API handles the dispatch.
  const canSend = $derived(canWrite && (inv.status === 'draft' || inv.status === 'sent'));
  const canMarkSent = $derived(canWrite && inv.status === 'draft');
  const canMarkPaid = $derived(canWrite && (inv.status === 'draft' || inv.status === 'sent'));
  const canVoid = $derived(canWrite && (inv.status === 'draft' || inv.status === 'sent'));
  // Edit gate matches the API's draft-only rule — once sent/paid/voided the
  // invoice belongs to the audit trail, not the editor.
  const canEdit = $derived(canWrite && inv.status === 'draft');
  const hasActions = $derived(canSend || canMarkSent || canMarkPaid || canVoid);

  // Public share URL is available once mark-sent mints the token. Built
  // server-side off event.url.origin so it works behind any proxy. Shown
  // alongside the email send so the user can also share the link directly.
  const publicUrl = $derived(inv.publicToken ? `${data.origin}/i/${inv.publicToken}` : null);

  // Send-form state: collapsed `to` override field, opens on a click.
  // Default `to` mirrors the contact's email when available.
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
  const canEditPayment = $derived(canWrite && inv.status === 'paid');
  let showEditPayment = $state(false);
</script>

<a href="/invoices" class="eyebrow text-fg/60 hover:text-fg">← Invoices</a>
<div class="mt-3 flex items-baseline justify-between gap-6">
  <h1 class="font-serif text-4xl font-light leading-none tracking-tight text-fg">
    Invoice {inv.number}<span class="text-accent">.</span>
  </h1>
  <div class="flex items-center gap-3">
    {#if canEdit}
      <a
        href="/invoices/{inv.id}/edit"
        class="rounded-sm border border-fg/20 px-3 py-1 font-mono text-xs uppercase tracking-widest text-fg/70 hover:border-accent hover:text-accent"
      >
        Edit
      </a>
    {/if}
    <!-- Duplicate-as-template: available for any status (a paid/sent invoice is
         a common template). Posts to ?/duplicate → new draft's edit page. -->
    {#if canWrite}
      <form method="post" action="?/duplicate">
        <button
          type="submit"
          class="rounded-sm border border-fg/20 px-3 py-1 font-mono text-xs uppercase tracking-widest text-fg/70 hover:border-accent hover:text-accent"
        >
          Duplicate
        </button>
      </form>
    {/if}
    <span class="font-mono text-xs uppercase tracking-widest text-fg/60">{inv.status}</span>
  </div>
</div>

{#if form?.transitionError}
  <div class="mt-6 rounded-sm border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
    {form.transitionError}
  </div>
{/if}

{#if data.sentTo}
  <div class="mt-6 rounded-sm border border-accent/30 bg-accent/5 px-4 py-3 text-sm text-fg">
    Sent to <span class="font-medium">{data.sentTo}</span>.
  </div>
{/if}

{#if data.needsBusinessDetails && inv.status === 'draft' && data.businessCompanyId && canManageSettings}
  <details class="mt-6 rounded-sm border border-accent/30 bg-accent/5 px-4 py-3 text-sm text-fg">
    <summary class="cursor-pointer list-none font-medium">
      Your business address won't show on this invoice yet.
      <span class="font-mono text-xs uppercase tracking-widest text-accent">Add it →</span>
    </summary>
    <form method="post" action="?/addBusinessDetails" class="mt-4 space-y-4">
      <input type="hidden" name="companyId" value={data.businessCompanyId} />
      <p class="text-fg/70">
        Add it once and it appears on this invoice and every one after. You can skip and send
        without — set it later from Settings → Business.
      </p>
      <label class="block">
        <span class="label">Business address</span>
        <textarea
          name="businessAddress"
          rows="3"
          placeholder="123 Main St&#10;Springfield, IL 62704"
          class="mt-2 w-full max-w-md rounded-sm border border-fg/20 bg-surface px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
        ></textarea>
      </label>
      <label class="block">
        <span class="label">Phone (optional)</span>
        <input
          type="tel"
          name="businessPhone"
          placeholder="(555) 123-4567"
          class="mt-2 w-full max-w-md rounded-sm border border-fg/20 bg-surface px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
        />
      </label>
      <button
        type="submit"
        class="btn"
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
            placeholder={contact?.email ?? 'recipient@example.com'}
            class="rounded-sm border border-fg/20 bg-surface-2 px-3 py-2 text-sm text-fg placeholder:text-fg/40 focus:border-accent focus:outline-none"
          />
        {/if}
        <SplitButton label="Send options" caretClass="border-l border-surface/20 bg-inverse text-on-inverse hover:bg-accent">
          {#snippet primary()}
            <button
              type="submit"
              class="rounded-l-sm bg-inverse px-4 py-2 text-sm font-medium text-on-inverse transition-colors hover:bg-accent"
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
              class="block w-full px-4 py-2 text-left text-sm text-fg/80 transition-colors hover:bg-surface-2 hover:text-fg"
            >
              Send to a different email…
            </button>
            {#if canMarkSent}
              <!-- Retargets the enclosing send form to ?/markSent via formaction
                   (no nested <form>). Like the Mark paid menu, the POST navigation
                   dismisses the menu itself, so we must NOT call close() or the
                   form detaches before submit. formnovalidate skips the optional
                   `to` email field's constraint check. -->
              <button
                type="submit"
                formaction="?/markSent"
                formnovalidate
                role="menuitem"
                class="block w-full border-t border-fg/10 px-4 py-2 text-left text-sm text-fg/80 transition-colors hover:bg-surface-2 hover:text-fg"
              >
                Mark sent without email
              </button>
            {/if}
          {/snippet}
        </SplitButton>
      </form>
    {/if}
    {#if canMarkPaid}
      <SplitButton label="Payment method" caretClass="border border-fg/20 bg-surface-2 text-fg hover:border-accent hover:text-accent">
        {#snippet primary()}
          <button
            type="button"
            onclick={() => {
              showPaidPanel = !showPaidPanel;
            }}
            class="rounded-l-sm border border-r-0 border-fg/20 bg-surface-2 px-4 py-2 text-sm font-medium text-fg transition-colors hover:border-accent hover:text-accent"
          >
            Mark paid
          </button>
        {/snippet}
        {#snippet menu()}
          <p class="px-4 py-2 font-mono text-xs uppercase tracking-widest text-fg/40">
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
                class="block w-full px-4 py-2 text-left text-sm text-fg/80 transition-colors hover:bg-surface-2 hover:text-fg"
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
          class="rounded-sm border border-danger/30 px-4 py-2 text-sm font-medium text-danger transition-colors hover:bg-danger/5"
        >
          Void
        </button>
      </form>
    {/if}
  </div>

  {#if canMarkPaid && showPaidPanel}
    <form
      method="post"
      action="?/markPaid"
      class="mt-4 max-w-md rounded-sm border border-fg/15 bg-surface-2 p-5"
    >
      <PaymentFields />
      <div class="mt-5 flex items-center gap-3">
        <button
          type="submit"
          class="btn"
        >
          Confirm paid
        </button>
        <button
          type="button"
          onclick={() => {
            showPaidPanel = false;
          }}
          class="text-xs uppercase tracking-widest text-fg/50 hover:text-accent"
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
        class="rounded-sm border border-fg/20 px-3 py-1 font-mono text-xs uppercase tracking-widest text-fg/70 hover:border-accent hover:text-accent"
      >
        Edit payment
      </button>
    {:else}
      <form
        method="post"
        action="?/editPayment"
        class="max-w-md rounded-sm border border-fg/15 bg-surface-2 p-5"
      >
        <PaymentFields
          method={inv.paymentMethod ?? 'cash'}
          reference={inv.paymentReference}
          date={inv.paidAt ? inv.paidAt.slice(0, 10) : undefined}
        />
        <div class="mt-5 flex items-center gap-3">
          <button
            type="submit"
            class="btn"
          >
            Update payment
          </button>
          <button
            type="button"
            onclick={() => {
              showEditPayment = false;
            }}
            class="text-xs uppercase tracking-widest text-fg/50 hover:text-accent"
          >
            Cancel
          </button>
        </div>
      </form>
    {/if}
  </div>
{/if}

{#if publicUrl}
  <div class="mt-6 rounded-sm border border-fg/10 bg-surface-2 p-4">
    <p class="label">Share link</p>
    <div class="mt-2 flex flex-wrap items-center gap-3 text-sm">
      <a href={publicUrl} target="_blank" rel="noopener" class="break-all text-accent hover:underline">
        {publicUrl}
      </a>
    </div>
    <p class="mt-2 text-xs text-fg/50">
      Anyone with this link can view the invoice.
    </p>
  </div>
{/if}

<dl class="mt-8 grid grid-cols-1 gap-x-12 gap-y-6 sm:grid-cols-3">
  <div>
    <dt class="label">Contact</dt>
    <dd class="mt-1 text-fg">
      {#if contact}
        <a href="/contacts/{contact.id}" class="hover:text-accent">{contact.name}</a>
      {:else}
        —
      {/if}
    </dd>
  </div>
  <div>
    <dt class="label">Issued</dt>
    <dd class="mt-1 text-fg">{inv.issueDate}</dd>
  </div>
  <div>
    <dt class="label">Due</dt>
    <dd class="mt-1 text-fg">{inv.dueDate}</dd>
  </div>
  {#if paidVia}
    <div>
      <dt class="label">Paid via</dt>
      <dd class="mt-1 text-fg">
        {paidVia}{#if inv.paymentReference} · {inv.paymentReference}{/if}
      </dd>
    </div>
  {/if}
  {#if inv.status === 'paid' && inv.paidAt}
    <div>
      <dt class="label">Paid on</dt>
      <dd class="mt-1 text-fg">{inv.paidAt.slice(0, 10)}</dd>
    </div>
  {/if}
</dl>

<div class="mt-10 overflow-hidden rounded-sm border border-fg/10 bg-surface-2">
  <table class="w-full text-left text-sm">
    <thead class="bg-surface">
      <tr class="label">
        <th class="px-5 py-3">Description</th>
        <th class="px-5 py-3 text-right">Qty</th>
        <th class="px-5 py-3 text-right">Unit price</th>
        <th class="px-5 py-3 text-right">Amount</th>
      </tr>
    </thead>
    <tbody class="divide-y divide-fg/10">
      {#each inv.lineItems as li (li.id)}
        <tr>
          <td class="px-5 py-4 text-fg">
            {li.description}
            {#if li.taxable}
              <span class="block text-xs text-fg/40">Taxable · {Number(li.taxRatePct)}%</span>
            {/if}
          </td>
          <td class="px-5 py-4 text-right font-mono tabular-nums text-fg/80">{li.quantity}</td>
          <td class="px-5 py-4 text-right font-mono tabular-nums text-fg/80">{formatUnitPrice(li.unitPrice)}</td>
          <td class="px-5 py-4 text-right font-mono tabular-nums text-fg">{li.amount}</td>
        </tr>
      {/each}
    </tbody>
    <tfoot class="bg-surface">
      <tr>
        <td colspan="3" class="px-5 py-3 text-right label">
          Subtotal
        </td>
        <td class="px-5 py-3 text-right font-mono tabular-nums text-fg">{inv.subtotal}</td>
      </tr>
      <tr>
        <td colspan="3" class="px-5 py-3 text-right label">
          Tax
        </td>
        <td class="px-5 py-3 text-right font-mono tabular-nums text-fg">{inv.tax}</td>
      </tr>
      <tr>
        <td colspan="3" class="px-5 py-3 text-right label">
          Total ({inv.currency})
        </td>
        <td class="px-5 py-3 text-right font-mono tabular-nums text-lg text-fg">{inv.total}</td>
      </tr>
    </tfoot>
  </table>
</div>

{#if inv.notes}
  <div class="mt-8">
    <h2 class="label">Notes</h2>
    <p class="mt-2 whitespace-pre-wrap text-fg/80">{inv.notes}</p>
  </div>
{/if}

<AuditHistory events={data.auditEvents} />

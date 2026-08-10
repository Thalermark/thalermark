<script lang="ts">
  import AuditHistory from '$lib/components/AuditHistory.svelte';
  import ConfirmSubmit from '$lib/components/ConfirmSubmit.svelte';
  import PaymentFields from '$lib/components/PaymentFields.svelte';
  import SplitButton from '$lib/components/SplitButton.svelte';
  import SubmitButton from '$lib/components/SubmitButton.svelte';
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

  // Partial payments (TMC-187). The panel renders whenever the API returned a
  // settlement summary — which it does for any invoice — but the record form is
  // gated on the same rule the API enforces: an issued invoice, and a settled
  // one only if it got there through payment rows. Mirroring the server rule
  // here keeps the button from offering a guaranteed 409.
  const settlement = $derived(data.settlement);
  const canRecordPayment = $derived(
    canWrite &&
      !!settlement &&
      (inv.status === 'sent' || (inv.status === 'paid' && settlement.payments.length > 0)),
  );
  let showPaymentPanel = $state(false);
  // Deposit form on a draft, collapsed until asked for (TMC-199).
  let showDeposit = $state(false);
  // Pre-fills the amount field with what is still owed — the overwhelmingly
  // common entry, and it saves the user doing the subtraction.
  const outstandingPlaceholder = $derived(settlement ? settlement.outstanding : '0.00');
  // Overpayment is stored as a negative outstanding; show it as a positive
  // "overpaid by" figure rather than making the reader parse a minus sign.
  const overpaidBy = $derived(
    settlement ? Math.abs(Number(settlement.outstanding)).toFixed(2) : '0.00',
  );
  const today = new Date().toISOString().slice(0, 10);

  function money(value: string): string {
    return `$${formatUnitPrice(Math.abs(Number(value)).toFixed(2))}`;
  }

  // The receipt list's two text runs, built as strings rather than inline {#if}
  // blocks: Svelte trims the whitespace at a block's edges, which ran the
  // separator into the previous word ("Check· 1024", "Refund$20.00").
  const paymentAmount = (amount: string) =>
    Number(amount) < 0 ? `Refund ${money(amount)}` : money(amount);

  function paymentMeta(p: { receivedOn: string; method: string; reference: string | null }) {
    const parts = [p.receivedOn, PAYMENT_METHOD_LABELS[p.method] ?? p.method];
    if (p.reference) parts.push(p.reference);
    return parts.join(' · ');
  }
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
        <SubmitButton
          label="Duplicate"
          pendingLabel="Duplicating…"
          class="rounded-sm border border-fg/20 px-3 py-1 font-mono text-xs uppercase tracking-widest text-fg/70 hover:border-accent hover:text-accent disabled:opacity-60"
        />
      </form>
    {/if}
    <span class="font-mono text-xs uppercase tracking-widest text-fg/60">{inv.status}</span>
  </div>
</div>

{#if form?.transitionError}
  <div class="mt-6 rounded-sm border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger" data-form-error role="alert" tabindex="-1">
    {form.transitionError}
  </div>
{/if}

{#if data.sentTo && data.sendUndelivered}
  <div class="mt-6 rounded-sm border border-warning/40 bg-warning/5 px-4 py-3 text-sm text-fg">
    Marked as sent — but <span class="font-medium">no email was delivered</span>. This server has no
    email set up, so nothing reached {data.sentTo}. The invoice is issued and its pay link works;
    send the customer that link yourself, or
    {#if canManageSettings}<a class="link" href="/settings/email">set up email</a>{:else}ask an
      owner to set up email{/if}.
  </div>
{:else if data.sentTo}
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
      <SubmitButton label="Save &amp; continue" pendingLabel="Saving…" class="btn" />
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
            <!-- The slowest button on the page: an SMTP round trip with no
                 feedback at all until now (TMC-218). -->
            <SubmitButton
              label={sendLabel}
              pendingLabel="Sending…"
              class="rounded-l-sm bg-inverse px-4 py-2 text-sm font-medium text-on-inverse transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
            />
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
              <SubmitButton
                formaction="?/markSent"
                formnovalidate
                role="menuitem"
                class="block w-full border-t border-fg/10 px-4 py-2 text-left text-sm text-fg/80 transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-60"
                pendingLabel="Marking sent…"
                label="Mark sent without email"
              />
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
              <SubmitButton
                role="menuitem"
                class="block w-full px-4 py-2 text-left text-sm text-fg/80 transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-60"
                label={choice.label}
                pendingLabel="Marking paid…"
              />
            </form>
          {/each}
        {/snippet}
      </SplitButton>
    {/if}
    {#if canVoid}
      <ConfirmSubmit
        action="?/void"
        label="Void"
        pendingLabel="Voiding…"
        title="Void invoice {inv.number}?"
        confirmLabel="Void invoice"
        triggerClass="rounded-sm border border-danger/30 px-4 py-2 text-sm font-medium text-danger transition-colors hover:bg-danger/5"
      >
        {#snippet body()}
          Voiding cancels the invoice and reverses the income it recorded. It stays on the books as
          a voided document — you can't reopen it or edit it afterwards, and the customer's pay link
          stops working.
        {/snippet}
      </ConfirmSubmit>
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
        <SubmitButton label="Confirm paid" pendingLabel="Marking paid…" class="btn" />
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
          <SubmitButton label="Update payment" pendingLabel="Saving…" class="btn" />
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

<!-- Taking a deposit on a draft, in one question (TMC-199).
     This box used to be sixty words explaining our state machine — issue it,
     mark it sent, then record a part-payment. The person reading it is standing
     in a customer's yard holding cash and knows exactly one thing: how much. So
     that is all it asks; issuing the invoice happens server-side in the same
     transaction.
     Collapsed by default: most drafts never take a deposit, and an open form
     on every one of them is noise. The question IS the affordance — someone who
     took money recognises it immediately, and everyone else reads past it. -->
{#if canWrite && inv.status === 'draft'}
  <section class="mt-8 rounded-sm border border-fg/10 bg-surface-2 p-5">
    <!-- One button that toggles, with a caret that turns — so it reads as an
         expandable section rather than a link that only goes one way. Closing
         it again matters: someone who opens it to look, and did not take a
         deposit, needs a way back to a quiet screen. -->
    <button
      type="button"
      onclick={() => {
        showDeposit = !showDeposit;
      }}
      aria-expanded={showDeposit}
      class="flex items-center gap-2 font-serif text-xl font-light text-fg hover:text-accent"
    >
      <span
        class="inline-block text-base text-fg/40 transition-transform duration-150"
        class:rotate-90={showDeposit}
        aria-hidden="true">&#9656;</span
      >
      Received a deposit?
    </button>
    {#if showDeposit}
      <form method="post" action="?/takeDeposit" class="mt-3 flex flex-wrap items-end gap-3">
        <input type="hidden" name="idempotencyKey" value={data.paymentKey} />
        <div>
          <label class="label" for="deposit-amount">How much</label>
          <input
            id="deposit-amount"
            name="amount"
            type="text"
            inputmode="decimal"
            required
            placeholder={inv.total}
            class="field mt-1 w-32 tabular-nums"
          />
        </div>
        <SubmitButton label="Record it" pendingLabel="Recording…" class="btn" />
      </form>
      <p class="mt-3 max-w-prose text-sm text-fg/60">
        We'll finish the invoice off and log what they paid. You can still send
        it to them whenever you like.
      </p>
      {#if form?.transitionError}
        <p class="mt-3 text-sm text-danger">{form.transitionError}</p>
      {/if}
    {/if}
  </section>
{/if}

{#if settlement && (settlement.payments.length > 0 || canRecordPayment)}
  <section class="mt-8 rounded-sm border border-fg/10 bg-surface-2 p-5">
    <div class="flex flex-wrap items-baseline justify-between gap-4">
      <h2 class="font-serif text-xl font-light text-fg">Payments</h2>
      <p class="text-sm text-fg/70">
        {#if settlement.settlement === 'overpaid'}
          Overpaid by <span class="tabular-nums text-fg">{money(overpaidBy)}</span>
        {:else if settlement.settlement === 'paid'}
          Paid in full
        {:else}
          <span class="tabular-nums text-fg">{money(settlement.paid)}</span> of
          <span class="tabular-nums text-fg">{money(inv.total)}</span> ·
          <span class="tabular-nums text-fg">{money(settlement.outstanding)}</span> still owed
        {/if}
      </p>
    </div>

    {#if settlement.payments.length > 0}
      <ul class="mt-4 divide-y divide-fg/10 border-y border-fg/10">
        {#each settlement.payments as p (p.id)}
          <li class="flex flex-wrap items-baseline justify-between gap-3 py-2.5 text-sm">
            <span class="text-fg/70">{paymentMeta(p)}</span>
            <span class="flex items-baseline gap-4">
              <!-- A negative row is a refund or credit note, not a receipt. Say
                   so in words rather than relying on the minus sign alone —
                   money() is already unsigned, so the word is what carries it. -->
              <span class="tabular-nums {Number(p.amount) < 0 ? 'text-fg/60' : 'text-fg'}">
                {paymentAmount(p.amount)}
              </span>
              {#if canRecordPayment}
                <ConfirmSubmit
                  action="?/removePayment"
                  label="Remove"
                  pendingLabel="Removing…"
                  title="Remove this {Number(p.amount) < 0 ? 'refund' : 'payment'}?"
                  confirmLabel="Remove"
                  hidden={{ paymentId: p.id }}
                  triggerClass="text-xs uppercase tracking-widest text-fg/40 hover:text-accent"
                >
                  {#snippet body()}
                    The {paymentAmount(p.amount)} recorded on {p.receivedOn} is deleted and its ledger
                    entry reversed. The invoice goes back to owing that much. Nothing here remembers
                    the reference or the method, so you'd have to re-enter them by hand.
                  {/snippet}
                </ConfirmSubmit>
              {/if}
            </span>
          </li>
        {/each}
      </ul>
    {/if}

    {#if canRecordPayment}
      {#if !showPaymentPanel}
        <button
          type="button"
          onclick={() => {
            showPaymentPanel = true;
          }}
          class="mt-4 rounded-sm border border-fg/20 px-3 py-1 font-mono text-xs uppercase tracking-widest text-fg/70 hover:border-accent hover:text-accent"
        >
          Record a payment
        </button>
      {:else}
        <form method="post" action="?/recordPayment" class="mt-4 max-w-md">
          <!-- Minted once per page render by the loader. Two clicks send the
               same key, and the server's partial unique index turns the second
               into a no-op instead of a second receipt (TMC-218). -->
          <input type="hidden" name="idempotencyKey" value={data.paymentKey} />
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="label" for="payment-amount">Amount</label>
              <input
                id="payment-amount"
                name="amount"
                type="text"
                inputmode="decimal"
                required
                class="field mt-1 tabular-nums"
                placeholder={outstandingPlaceholder}
              />
            </div>
            <div>
              <label class="label" for="payment-date">Date received</label>
              <input
                id="payment-date"
                name="receivedOn"
                type="date"
                required
                value={today}
                class="field mt-1"
              />
            </div>
          </div>
          <div class="mt-4 grid grid-cols-2 gap-4">
            <div>
              <label class="label" for="payment-method">Method</label>
              <select id="payment-method" name="method" class="field mt-1">
                {#each PAID_METHOD_CHOICES as choice (choice.value)}
                  <option value={choice.value}>{choice.label}</option>
                {/each}
              </select>
            </div>
            <div>
              <!-- Direction rather than a typed minus sign: nobody should have
                   to know that a refund is a negative payment. -->
              <label class="label" for="payment-direction">Type</label>
              <select id="payment-direction" name="direction" class="field mt-1">
                <option value="in">Payment received</option>
                <option value="out">Refund or credit</option>
              </select>
            </div>
          </div>
          <div class="mt-4">
            <label class="label" for="payment-reference">Reference (optional)</label>
            <input
              id="payment-reference"
              name="reference"
              type="text"
              maxlength="100"
              class="field mt-1"
              placeholder="Check number, confirmation code"
            />
          </div>
          <div class="mt-5 flex items-center gap-3">
            <SubmitButton label="Record payment" pendingLabel="Recording…" class="btn" />
            <button
              type="button"
              onclick={() => {
                showPaymentPanel = false;
              }}
              class="text-xs uppercase tracking-widest text-fg/50 hover:text-accent"
            >
              Cancel
            </button>
          </div>
        </form>
      {/if}
    {/if}

    <!-- Automatic reminders for this one invoice (TMC-189). Lives in the
         Payments panel rather than the action row because it is part of the
         money conversation with this customer, not a document state change
         like send or void.
         Titled and stateful on purpose: a bare "stop reminding" link tells a
         user nothing about whether reminders exist, whether they are on, or
         what stopping would change. -->
    {#if canWrite && inv.status !== 'voided'}
      <div class="mt-5 border-t border-fg/10 pt-4">
        <h3 class="label">Automatic reminders</h3>
        {#if !data.companyRemindersEnabled}
          <p class="mt-1 text-sm text-fg/60">
            Off for this business. <a href="/settings/reminders" class="link">Turn them on</a>
            to chase unpaid invoices automatically.
          </p>
        {:else if inv.remindersOptedOut}
          <p class="mt-1 text-sm text-fg/70">Paused for this invoice — we won't chase it.</p>
          <form method="post" action="?/setReminders" class="mt-1">
            <input type="hidden" name="optedOut" value="false" />
            <SubmitButton label="Resume reminders" pendingLabel="Resuming…" class="link text-sm" />
          </form>
        {:else}
          <p class="mt-1 text-sm text-fg/70">
            On — we'll chase this invoice until it's paid in full.
          </p>
          <form method="post" action="?/setReminders" class="mt-1">
            <input type="hidden" name="optedOut" value="true" />
            <SubmitButton label="Pause for this invoice" pendingLabel="Pausing…" class="link text-sm" />
          </form>
        {/if}
      </div>
    {/if}

  </section>
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
          <td class="px-5 py-4 text-right font-mono tabular-nums text-fg/80"
            >{li.quantity}{#if li.unitLabel}&nbsp;{li.unitLabel}{/if}</td
          >
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

<!--
  What this job made (TMC-174). INTERNAL — this block is on the app page only;
  the customer's copy is rendered by /i/[token] from a different payload that
  never carries cost. Showing it here because this is the screen the user is
  already on when he wonders whether the work was worth it.

  Only appears once at least one cost is tagged: an empty margin block on every
  invoice would be noise for users who never use the feature.
-->
{#if inv.jobCosting && inv.jobCosting.costCount > 0}
  <div class="mt-8 rounded-sm border border-fg/10 bg-surface-2 p-5">
    <h2 class="label">What this job made</h2>
    <dl class="mt-3 max-w-xs space-y-2 text-sm">
      <div class="flex justify-between gap-6">
        <dt class="text-fg/60">Billed</dt>
        <dd class="font-mono tabular-nums text-fg/80">{inv.jobCosting.billed}</dd>
      </div>
      <!--
        Only on a draft. This invoice isn't billed anything yet, so showing the
        amount here is the difference between "no revenue" and "no revenue YET"
        — and a voided invoice deliberately shows nothing, because nothing is
        coming.
      -->
      {#if Number(inv.jobCosting.drafted) > 0}
        <div class="flex justify-between gap-6">
          <dt class="text-fg/60">Drafted<span class="ml-2 text-xs text-fg/40">not sent</span></dt>
          <dd class="font-mono tabular-nums text-fg/80">{inv.jobCosting.drafted}</dd>
        </div>
      {/if}
      <div class="flex justify-between gap-6">
        <dt class="text-fg/60">
          Costs
          <span class="text-xs text-fg/40">
            ({inv.jobCosting.costCount}
            {inv.jobCosting.costCount === 1 ? 'receipt' : 'receipts'})
          </span>
        </dt>
        <dd class="font-mono tabular-nums text-fg/80">−{inv.jobCosting.costs}</dd>
      </div>
      <!--
        A dash while the money is still coming, a real figure once it is settled
        one way or the other. A DRAFT states nothing; a VOIDED invoice states the
        loss, because the work was done, the receipts are real, and nobody will
        ever be billed for it (TMC-204).
      -->
      <div class="flex justify-between gap-6 border-t border-fg/10 pt-2">
        <dt class="text-fg">Made</dt>
        <dd class="font-mono text-base tabular-nums text-fg">
          {inv.jobCosting.made ?? '—'}
        </dd>
      </div>
      {#if inv.jobCosting.made === null}
        <p class="text-xs text-fg/50">Nothing billed yet — send the invoice to see what it made.</p>
      {/if}
    </dl>
    <p class="mt-3 text-xs text-fg/50">
      Billed is pre-tax. Only your customer sees the invoice — this is for you.
    </p>
  </div>
{/if}

<AuditHistory events={data.auditEvents} />

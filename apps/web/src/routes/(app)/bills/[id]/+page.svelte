<script lang="ts">
  import AuditHistory from '$lib/components/AuditHistory.svelte';
  import ConfirmSubmit from '$lib/components/ConfirmSubmit.svelte';
  import SubmitButton from '$lib/components/SubmitButton.svelte';
  import PaymentFields from '$lib/components/PaymentFields.svelte';
  import { may } from '$lib/perms';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const bill = $derived(data.bill);
  const canWrite = $derived(may(data.role, 'expenses:write'));
  const isOpen = $derived(bill.status === 'open');

  const fmt = (s: string) =>
    Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  function statusClass(status: string): string {
    return status === 'paid'
      ? 'bg-accent/15 text-accent'
      : status === 'voided'
        ? 'bg-fg/10 text-fg/50'
        : 'bg-warning/15 text-warning';
  }

  let showPay = $state(false);

  // Partial payments (TMC-192). The panel renders whenever the API returned a
  // settlement summary — which it does for any bill — but the record form is
  // gated the way the server gates it: an open bill always, a paid one only if
  // it got there through payment rows. Mirroring the server rule keeps the UI
  // from offering an action the API will refuse.
  const settlement = $derived(data.settlement);
  const canRecordPayment = $derived(
    canWrite &&
      !!settlement &&
      (bill.status === 'open' || (bill.status === 'paid' && settlement.payments.length > 0)),
  );
  let showPaymentPanel = $state(false);

  // mark-paid settles the whole amount in one shot and the server refuses it
  // once payments exist, so the quick button hides as soon as the bill is
  // partly settled — the panel below is the way in from then on.
  const canMarkPaid = $derived(canWrite && isOpen && (settlement?.payments.length ?? 0) === 0);

  // How a payment was made. Falls back to the raw code for forward-compat if a
  // new method lands before this map is updated. No 'stripe' — that is the
  // collecting side, not the paying side.
  const PAYMENT_METHOD_LABELS: Record<string, string> = {
    cash: 'Cash',
    check: 'Check',
    venmo: 'Venmo',
    zelle: 'Zelle',
    other: 'Other',
  };
  const PAID_METHOD_CHOICES = [
    { value: 'cash', label: 'Cash' },
    { value: 'check', label: 'Check' },
    { value: 'venmo', label: 'Venmo' },
    { value: 'zelle', label: 'Zelle' },
    { value: 'other', label: 'Other' },
  ] as const;

  // The one-line "when and how" under a payment. Built as a string rather than
  // inline {#if} blocks because Svelte swallows the leading whitespace of a
  // block, which ran the separator into the previous word ("Cash· Cash").
  //
  // The account is deliberately absent: every payment leaves from Cash today,
  // so naming it would read "Cash · Cash" and tell the user nothing.
  // "Refund $20.00", not "Refund-$20.00". Two reasons it is a function: Svelte
  // trims the trailing space inside an {#if} block, which ran the word into the
  // number, and the word already carries the direction — so the magnitude reads
  // better than a second negative. Matches how the summary line says "Overpaid
  // by $30.00", and how mobile has always rendered it.
  const paymentAmount = (amount: string) =>
    Number(amount) < 0 ? `Refund ${fmt(String(Math.abs(Number(amount))))}` : fmt(amount);

  function paymentMeta(p: { paidOn: string; method: string; reference: string | null }) {
    const parts = [p.paidOn, PAYMENT_METHOD_LABELS[p.method] ?? p.method];
    if (p.reference) parts.push(p.reference);
    return parts.join(' · ');
  }

  const outstandingPlaceholder = $derived(settlement ? settlement.outstanding : '0.00');
  // Overpayment is stored as a negative outstanding; show it as a positive
  // "overpaid by".
  const overpaidBy = $derived(
    settlement ? Math.abs(Number(settlement.outstanding)).toFixed(2) : '0.00',
  );
  // The company's calendar day, from the server load (TMC-303), never the
  // browser's UTC slice, which dates an evening payment tomorrow.
  const today = $derived(data.today);
</script>

<a href="/bills" class="eyebrow text-fg/60 hover:text-fg">← Bills</a>

<div class="mt-3 flex flex-wrap items-baseline justify-between gap-4">
  <h1 class="font-serif text-4xl font-light leading-none tracking-tight text-fg">
    {bill.vendorName}<span class="text-accent">.</span>
  </h1>
  <span
    class="rounded-sm px-2.5 py-1 text-xs font-medium uppercase tracking-wide {statusClass(
      bill.status,
    )}"
  >
    {bill.status}
  </span>
</div>

{#if form?.transitionError}
  <p class="callout mt-6 border-danger/30 bg-danger/5 text-danger">{form.transitionError}</p>
{/if}

<dl class="mt-8 grid max-w-2xl grid-cols-1 gap-x-10 gap-y-5 sm:grid-cols-2">
  <div>
    <dt class="label">Amount</dt>
    <dd class="mt-1 font-serif text-2xl font-light tabular-nums text-fg">{fmt(bill.amount)}</dd>
  </div>
  <div>
    <dt class="label">Category</dt>
    <dd class="mt-1 text-sm text-fg/80">{data.categoryLabel}</dd>
  </div>
  <div>
    <dt class="label">Bill date</dt>
    <dd class="mt-1 font-mono tabular-nums text-sm text-fg/80">{bill.billDate}</dd>
  </div>
  <div>
    <dt class="label">Due date</dt>
    <dd class="mt-1 font-mono tabular-nums text-sm text-fg/80">{bill.dueDate}</dd>
  </div>
  {#if bill.reference}
    <div>
      <dt class="label">Reference</dt>
      <dd class="mt-1 font-mono text-sm text-fg/80">#{bill.reference}</dd>
    </div>
  {/if}
  {#if bill.memo}
    <div class="sm:col-span-2">
      <dt class="label">Memo</dt>
      <dd class="mt-1 whitespace-pre-line text-sm text-fg/80">{bill.memo}</dd>
    </div>
  {/if}
</dl>

{#if bill.status === 'paid'}
  <div class="mt-8 max-w-2xl rounded-sm border border-accent/30 bg-accent/5 p-5">
    <p class="label">Paid</p>
    <dl class="mt-2 grid grid-cols-1 gap-x-10 gap-y-2 text-sm text-fg/80 sm:grid-cols-2">
      <div><span class="text-fg/50">Method:</span> {bill.paymentMethod}</div>
      {#if bill.paymentReference}
        <div><span class="text-fg/50">Reference:</span> {bill.paymentReference}</div>
      {/if}
      {#if bill.paidAt}
        <div><span class="text-fg/50">On:</span> {bill.paidAt.slice(0, 10)}</div>
      {/if}
      {#if data.paymentLabel}
        <div><span class="text-fg/50">From:</span> {data.paymentLabel}</div>
      {/if}
    </dl>
  </div>
{/if}

{#if canWrite && isOpen}
  <div class="mt-8 flex flex-wrap items-center gap-4">
    {#if canMarkPaid}
      <button type="button" class="btn" onclick={() => (showPay = !showPay)}>Mark paid</button>
    {/if}
    <a href="/bills/{bill.id}/edit" class="text-sm text-fg/70 hover:text-fg">Edit</a>
    <ConfirmSubmit
      action="?/void"
      label="Void"
      pendingLabel="Voiding…"
      title="Void this bill?"
      confirmLabel="Void bill"
      triggerClass="text-sm text-fg/50 hover:text-danger"
    >
      {#snippet body()}
        The bill is cancelled and whatever is still owed on it comes off what you owe. It stays on
        the books as a voided bill and cannot be reopened or edited afterwards.
      {/snippet}
    </ConfirmSubmit>
  </div>

  {#if showPay && canMarkPaid}
    <form method="POST" action="?/markPaid" class="mt-6 max-w-xl rounded-sm border border-fg/10 bg-surface-2 p-5">
      <PaymentFields today={data.today} accounts={data.moneyAccounts} />
      <div class="mt-5 flex items-center gap-4">
        <SubmitButton label="Pay in full" pendingLabel="Recording…" class="btn" />
        <button type="button" class="text-sm text-fg/60 hover:text-fg" onclick={() => (showPay = false)}>
          Cancel
        </button>
      </div>
    </form>
  {/if}
{/if}

<!-- Payments (TMC-192) — the vendor-deposit path. Mark paid above settles the
     whole amount in one go; this is where a deposit, a progress payment, or a
     refund from the vendor lives. -->
{#if settlement && (settlement.payments.length > 0 || canRecordPayment)}
  <section class="mt-8 max-w-2xl rounded-sm border border-fg/10 bg-surface-2 p-5">
    <div class="flex flex-wrap items-baseline justify-between gap-4">
      <h2 class="font-serif text-xl font-light text-fg">Payments</h2>
      <p class="text-sm text-fg/70">
        {#if settlement.settlement === 'overpaid'}
          Overpaid by <span class="tabular-nums text-fg">{fmt(overpaidBy)}</span>
        {:else if settlement.settlement === 'paid'}
          Paid in full
        {:else}
          <span class="tabular-nums text-fg">{fmt(settlement.paid)}</span> of
          <span class="tabular-nums text-fg">{fmt(bill.amount)}</span> ·
          <span class="tabular-nums text-fg">{fmt(settlement.outstanding)}</span> still owing
        {/if}
      </p>
    </div>

    {#if settlement.payments.length > 0}
      <ul class="mt-4 divide-y divide-fg/10 border-y border-fg/10">
        {#each settlement.payments as p (p.id)}
          <li class="flex flex-wrap items-baseline justify-between gap-3 py-2.5 text-sm">
            <span class="text-fg/70">{paymentMeta(p)}</span>
            <span class="flex items-baseline gap-4">
              <!-- A negative row is money coming BACK from the vendor. Say so in
                   words rather than relying on the minus sign alone. -->
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
                    The {paymentAmount(p.amount)} recorded on {p.paidOn} is taken back off your
                    books, so the bill goes back to owing that much. The reference and method are
                    not kept anywhere else, so you would re-enter them by hand.
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
          onclick={() => (showPaymentPanel = true)}
          class="mt-4 rounded-sm border border-fg/20 px-3 py-1 font-mono text-xs uppercase tracking-widest text-fg/70 hover:border-accent hover:text-accent"
        >
          Record a payment
        </button>
      {:else}
        <form method="POST" action="?/recordPayment" class="mt-4 max-w-md">
          <!-- Same key on both clicks of a double-click; the server keeps one
               (TMC-218). -->
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
              <label class="label" for="payment-date">Date paid</label>
              <input
                id="payment-date"
                name="paidOn"
                type="date"
                required
                value={today}
                max={today}
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
                   to know that a vendor refund is a negative payment. -->
              <label class="label" for="payment-direction">Type</label>
              <select id="payment-direction" name="direction" class="field mt-1">
                <option value="out">Payment made</option>
                <option value="in">Refund from vendor</option>
              </select>
            </div>
          </div>
          <!-- No "paid from" picker. Each payment DOES carry its own account —
               that is why bill_payments has the column — but the chart is
               seed-only and Cash (1000) is the only account money can leave
               from, so a picker would offer Accounts Receivable and
               Accumulated Depreciation as places to pay a vendor from. The
               server resolves Cash; when a second bank account can exist, the
               picker belongs here. -->
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
              onclick={() => (showPaymentPanel = false)}
              class="text-xs uppercase tracking-widest text-fg/50 hover:text-accent"
            >
              Cancel
            </button>
          </div>
        </form>
      {/if}
    {/if}
  </section>
{/if}

<div class="mt-12 max-w-2xl">
  <AuditHistory events={data.auditEvents} />
</div>

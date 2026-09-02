<script lang="ts">
  // Shared payment-detail inputs for both mark-paid (fresh) and edit-payment
  // (pre-filled). Renders the method radios + a conditional Check#/Note field +
  // a payment-date input capped at today. Field names match the API schema
  // (method / reference / paidOn); the parent <form> owns the action + submit.
  //
  // Optionally renders the money-account picker too (TMC-207), because "how was
  // it paid" and "which account did it move through" are the same moment for
  // the user. Field NAME differs by direction — bills pay FROM an account,
  // invoices deposit INTO one — so the caller supplies it.
  let {
    method = 'cash',
    reference = null,
    date,
    // Today as the COMPANY's calendar day, from the caller's server load
    // (TMC-303). The UTC fallback below is the pre-TMC-303 behaviour for any
    // caller not passing it: an evening default dated tomorrow, and in zones
    // ahead of UTC a max-cap of yesterday that blocks a same-day payment.
    today = new Date().toISOString().slice(0, 10),
    accounts = [],
    accountField = 'paymentAccountId',
    accountLabel = 'Paid from',
    // Nothing is ever deposited into a credit card, so the money-in callers
    // pass false and get bank accounts only.
    allowCards = true,
  }: {
    method?: string;
    reference?: string | null;
    date?: string;
    today?: string;
    accounts?: { id: string; name: string; kind: string | null }[];
    accountField?: string;
    accountLabel?: string;
    allowCards?: boolean;
  } = $props();

  const KIND_LABEL: Record<string, string> = {
    checking: 'Checking',
    savings: 'Savings',
    cash: 'Cash',
    credit_card: 'Credit card',
  };

  // Hidden entirely while there is one account: picking from a list of one is
  // noise, and omitting the field is exactly the request a pre-TMC-207 form
  // made, so the server takes its existing default path.
  const accountOptions = $derived(
    allowCards ? accounts : accounts.filter((a) => a.kind !== 'credit_card'),
  );

  const CHOICES = [
    { value: 'cash', label: 'Cash' },
    { value: 'check', label: 'Check' },
    { value: 'venmo', label: 'Venmo' },
    { value: 'zelle', label: 'Zelle' },
    { value: 'other', label: 'Other' },
  ] as const;

  // selected seeds from the method prop (initial value only — the radios own it
  // after mount); the prop is stable per panel render, so capturing the initial
  // is intended.
  // svelte-ignore state_referenced_locally
  let selected = $state(method);
  const dateValue = $derived(date ?? today);
</script>

<p class="label">How was it paid?</p>
<div class="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm text-fg">
  {#each CHOICES as choice (choice.value)}
    <label class="flex items-center gap-2">
      <input
        type="radio"
        name="method"
        value={choice.value}
        bind:group={selected}
        class="text-accent focus:ring-accent"
      />
      {choice.label}
    </label>
  {/each}
</div>
{#if selected === 'check'}
  <label class="mt-4 grid max-w-xs gap-1 text-sm text-fg">
    Check number
    <input
      name="reference"
      value={reference ?? ''}
      placeholder="e.g. 1024"
      class="rounded-sm border border-fg/20 bg-surface px-3 py-2 focus:border-accent focus:outline-none"
    />
  </label>
{:else if selected === 'other'}
  <label class="mt-4 grid max-w-sm gap-1 text-sm text-fg">
    Note
    <textarea
      name="reference"
      rows="2"
      placeholder="How was it paid?"
      class="rounded-sm border border-fg/20 bg-surface px-3 py-2 focus:border-accent focus:outline-none"
      >{reference ?? ''}</textarea
    >
  </label>
{/if}
{#if accountOptions.length > 1}
  <label class="mt-4 grid max-w-xs gap-1 text-sm text-fg">
    {accountLabel}
    <select
      name={accountField}
      class="rounded-sm border border-fg/20 bg-surface px-3 py-2 focus:border-accent focus:outline-none"
    >
      {#each accountOptions as a (a.id)}
        <option value={a.id}>{a.name}{a.kind ? ` · ${KIND_LABEL[a.kind] ?? ''}` : ''}</option>
      {/each}
    </select>
  </label>
{/if}
<label class="mt-4 grid max-w-xs gap-1 text-sm text-fg">
  Payment date
  <input
    type="date"
    name="paidOn"
    value={dateValue}
    max={today}
    class="rounded-sm border border-fg/20 bg-surface px-3 py-2 focus:border-accent focus:outline-none"
  />
</label>

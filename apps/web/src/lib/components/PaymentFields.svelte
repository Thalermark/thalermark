<script lang="ts">
  // Shared payment-detail inputs for both mark-paid (fresh) and edit-payment
  // (pre-filled). Renders the method radios + a conditional Check#/Note field +
  // a payment-date input capped at today. Field names match the API schema
  // (method / reference / paidOn); the parent <form> owns the action + submit.
  let {
    method = 'cash',
    reference = null,
    date,
  }: { method?: string; reference?: string | null; date?: string } = $props();

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
  const today = new Date().toISOString().slice(0, 10);
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

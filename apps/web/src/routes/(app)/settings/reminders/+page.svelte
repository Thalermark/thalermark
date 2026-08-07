<script lang="ts">
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  // Local, editable copies. Positive numbers in both lists — the group carries
  // the sign, so nobody types a minus.
  // Seeded from `data` and RESYNCED when it changes. Without the effect these
  // capture only the first render, so switching company in the switcher would
  // leave the previous company's schedule sitting in the form — and saving it
  // would write those offsets onto the wrong business.
  let enabled = $state(false);
  let before = $state<number[]>([]);
  let after = $state<number[]>([]);
  $effect(() => {
    enabled = data.company.remindersEnabled ?? false;
    before = [...data.before];
    after = [...data.after];
  });

  const total = $derived(before.length + after.length);
  const atLimit = $derived(total >= data.limits.maxStages);
</script>

<h1 class="font-serif text-2xl font-light text-fg">Payment reminders</h1>
<p class="mt-2 max-w-prose text-sm text-fg/70">
  Chase unpaid invoices automatically. Reminders are sent to your customer, from
  you, and stop as soon as an invoice is paid in full.
</p>

<form method="post" action="?/save" class="mt-8 max-w-xl">
  <input type="hidden" name="companyId" value={data.company.id} />

  <label class="flex items-start gap-3">
    <input type="checkbox" name="remindersEnabled" bind:checked={enabled} class="mt-1" />
    <span>
      <span class="text-fg">Send payment reminders automatically</span>
      <span class="mt-1 block text-sm text-fg/60">
        Off by default. Nothing is sent until you turn this on.
      </span>
    </span>
  </label>

  <div class="mt-8 space-y-8" class:opacity-50={!enabled}>
    <fieldset disabled={!enabled}>
      <legend class="label">Before it's due</legend>
      <p class="mt-1 text-sm text-fg/60">A gentle heads-up while there's still time.</p>
      {#each before as days, i (i)}
        <div class="mt-2 flex items-center gap-3">
          <input
            type="number"
            name="before"
            bind:value={before[i]}
            min="1"
            max={Math.abs(data.limits.minOffset)}
            class="field w-24 tabular-nums"
          />
          <span class="text-sm text-fg/70">days before</span>
          <button
            type="button"
            onclick={() => (before = before.filter((_, n) => n !== i))}
            class="text-xs uppercase tracking-widest text-fg/40 hover:text-accent"
          >Remove</button>
        </div>
      {/each}
      {#if !atLimit}
        <button
          type="button"
          onclick={() => (before = [...before, 5])}
          class="mt-3 rounded-sm border border-fg/20 px-3 py-1 font-mono text-xs uppercase tracking-widest text-fg/70 hover:border-accent hover:text-accent"
        >Add a reminder</button>
      {/if}
    </fieldset>

    <fieldset disabled={!enabled}>
      <legend class="label">After it's due</legend>
      <p class="mt-1 text-sm text-fg/60">A nudge once it's late.</p>
      {#each after as days, i (i)}
        <div class="mt-2 flex items-center gap-3">
          <input
            type="number"
            name="after"
            bind:value={after[i]}
            min="0"
            max={data.limits.maxOffset}
            class="field w-24 tabular-nums"
          />
          <span class="text-sm text-fg/70">days after</span>
          <button
            type="button"
            onclick={() => (after = after.filter((_, n) => n !== i))}
            class="text-xs uppercase tracking-widest text-fg/40 hover:text-accent"
          >Remove</button>
        </div>
      {/each}
      {#if !atLimit}
        <button
          type="button"
          onclick={() => (after = [...after, 7])}
          class="mt-3 rounded-sm border border-fg/20 px-3 py-1 font-mono text-xs uppercase tracking-widest text-fg/70 hover:border-accent hover:text-accent"
        >Add a reminder</button>
      {/if}
    </fieldset>
  </div>

  {#if atLimit}
    <p class="mt-6 text-sm text-fg/60">
      That's the maximum of {data.limits.maxStages} reminders. More than this reads
      as harassment to a customer, and it puts your email deliverability at risk.
    </p>
  {/if}

  <p class="mt-6 max-w-prose text-sm text-fg/60">
    Reminders quote what's still owed, not the invoice total — so a customer who
    paid a deposit is only chased for the balance. Nothing is sent within a few
    days of a payment arriving, and you can turn reminders off for any single
    invoice from that invoice.
  </p>

  {#if form?.saveError}
    <p class="mt-4 text-sm text-danger">
      Couldn't save that. Check each reminder is a different number of days.
    </p>
  {:else if form?.saved}
    <p class="mt-4 text-sm text-fg/70">Saved.</p>
  {/if}

  <button type="submit" class="btn mt-6">Save</button>
</form>

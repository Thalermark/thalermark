<script lang="ts">
  import { may } from '$lib/perms';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();

  const canManage = $derived(may(data.role, 'settings:manage'));
  const accounts = $derived(data.moneyAccounts);

  // The words the user picks between. Never "asset" or "liability" — those are
  // what the system derives from this choice, not what anyone is asked.
  const KINDS: { value: string; label: string; hint: string }[] = [
    { value: 'checking', label: 'Checking', hint: 'A business current account' },
    { value: 'savings', label: 'Savings', hint: 'Money set aside' },
    { value: 'cash', label: 'Cash', hint: 'A till, a cash box, an envelope in the truck' },
    { value: 'credit_card', label: 'Credit card', hint: 'Spend now, pay the statement later' },
  ];

  const KIND_LABEL: Record<string, string> = {
    checking: 'Checking',
    savings: 'Savings',
    cash: 'Cash',
    credit_card: 'Credit card',
  };

  const fmt = (s: string) =>
    Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  // A card's stored balance is credit-normal, so it comes back negative when
  // money is owed. Owing $150 reads as "$150 owed", never "-$150".
  function balanceLabel(kind: string, balance: string): string {
    const n = Number(balance);
    if (kind === 'credit_card') {
      if (n === 0) return 'Nothing owed';
      return `${fmt(Math.abs(n).toFixed(2))} owed`;
    }
    return fmt(balance);
  }

  let renaming = $state<string | null>(null);
  let adding = $state(false);
</script>

<div class="flex items-baseline justify-between gap-6">
  <div>
    <span class="eyebrow">Settings</span>
    <h1 class="mt-2 font-serif text-4xl font-light leading-none tracking-tight text-fg">
      Accounts<span class="text-accent">.</span>
    </h1>
  </div>
  {#if canManage && data.companyId}
    <button type="button" class="btn" onclick={() => (adding = !adding)}>
      {adding ? 'Cancel' : '+ Add account'}
    </button>
  {/if}
</div>

<p class="mt-3 max-w-2xl text-sm text-fg/60">
  Every place your money sits — the bank account you get paid into, the card you fill the truck
  with, the cash box. Once an account is here you can say which one a payment came from or landed
  in.
</p>

{#if form?.actionError}
  <p class="mt-4 text-sm text-danger">{form.actionError}</p>
{/if}

{#if adding && data.companyId}
  <form method="post" action="?/create" class="mt-6 rounded-sm border border-fg/15 bg-surface-2 p-5">
    <input type="hidden" name="companyId" value={data.companyId} />
    <label class="block">
      <span class="label">Name</span>
      <input
        name="name"
        required
        maxlength="200"
        placeholder="Chase Business Checking"
        class="mt-2 w-full max-w-md rounded-sm border border-fg/20 bg-surface px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
      />
      <span class="mt-1 block text-xs text-fg/50">
        Call it whatever you call it. This is the name you'll see when picking.
      </span>
    </label>

    <fieldset class="mt-5">
      <legend class="label">What kind of account is it?</legend>
      <div class="mt-2 grid gap-2 sm:grid-cols-2">
        {#each KINDS as k (k.value)}
          <label
            class="flex cursor-pointer items-start gap-3 rounded-sm border border-fg/15 bg-surface px-3 py-2.5 hover:border-accent"
          >
            <input
              type="radio"
              name="kind"
              value={k.value}
              required
              class="mt-1 border-fg/30 text-accent focus:ring-accent"
            />
            <span>
              <span class="block text-sm text-fg">{k.label}</span>
              <span class="block text-xs text-fg/50">{k.hint}</span>
            </span>
          </label>
        {/each}
      </div>
    </fieldset>

    <div class="mt-5 flex items-center gap-3">
      <button type="submit" class="btn">Add account</button>
      <button type="button" class="text-sm text-fg/60 hover:text-fg" onclick={() => (adding = false)}>
        Cancel
      </button>
    </div>

    <!--
      Deliberately no "starting balance" field. Two ways to inject a starting
      figure would be two sources of truth for the same equity; the two that
      already exist are the right ones.
    -->
    <p class="mt-4 max-w-xl text-xs text-fg/50">
      Already got money in this account? Add it afterwards under <a class="link" href="/owner-money"
        >My Money</a
      >, or — if you're moving over from another system mid-year — through the starting balances in
      <a class="link" href="/settings/business">Business</a>.
    </p>
  </form>
{/if}

<div class="mt-6">
  <a
    href={data.showArchived ? '/settings/accounts' : '/settings/accounts?archived=1'}
    class="label hover:text-accent"
  >
    {data.showArchived ? '← Hide archived' : 'Show archived'}
  </a>
</div>

{#if accounts.length === 0}
  <p class="mt-8 text-fg/70">No accounts yet.</p>
{:else}
  <ul class="mt-6 divide-y divide-fg/10 rounded-sm border border-fg/10 bg-surface-2">
    {#each accounts as a (a.id)}
      <li class="px-5 py-4">
        {#if renaming === a.id}
          <form method="post" action="?/rename" class="flex flex-wrap items-center gap-3">
            <input type="hidden" name="id" value={a.id} />
            <input
              name="name"
              value={a.name}
              required
              maxlength="200"
              class="min-w-60 flex-1 rounded-sm border border-fg/20 bg-surface px-3 py-1.5 text-sm text-fg focus:border-accent focus:outline-none"
            />
            <button type="submit" class="btn">Save</button>
            <button
              type="button"
              class="text-sm text-fg/60 hover:text-fg"
              onclick={() => (renaming = null)}
            >
              Cancel
            </button>
          </form>
        {:else}
          <div class="flex flex-wrap items-center justify-between gap-4">
            <div class="min-w-0">
              <span class="font-serif text-lg text-fg">{a.name}</span>
              {#if !a.isActive}
                <span
                  class="ml-2 rounded-sm border border-fg/15 px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-widest text-fg/50"
                >
                  Archived
                </span>
              {/if}
              <span class="mt-0.5 block text-xs text-fg/50">{KIND_LABEL[a.kind ?? ''] ?? ''}</span>
            </div>
            <span class="font-mono text-sm tabular-nums text-fg/80">
              {balanceLabel(a.kind ?? '', a.balance)}
            </span>
            {#if canManage}
              <div class="flex items-center gap-2">
                <button
                  type="button"
                  class="rounded-sm border border-fg/15 px-2 py-1 font-mono text-xs uppercase tracking-widest text-fg/60 transition-colors hover:border-accent hover:text-accent"
                  onclick={() => (renaming = a.id)}
                >
                  Rename
                </button>
                <form method="post" action={a.isActive ? '?/archive' : '?/restore'}>
                  <input type="hidden" name="id" value={a.id} />
                  <button
                    type="submit"
                    class="rounded-sm border border-fg/15 px-2 py-1 font-mono text-xs uppercase tracking-widest text-fg/60 transition-colors hover:border-accent hover:text-accent"
                  >
                    {a.isActive ? 'Archive' : 'Restore'}
                  </button>
                </form>
              </div>
            {/if}
          </div>
        {/if}
      </li>
    {/each}
  </ul>
  <p class="mt-4 max-w-2xl text-xs text-fg/50">
    Archiving takes an account out of the pickers. It stays on your books with whatever balance it
    holds — nothing you've already recorded changes.
  </p>
{/if}

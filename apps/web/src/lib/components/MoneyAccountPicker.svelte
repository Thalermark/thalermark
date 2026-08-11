<script lang="ts">
  // "Where did the money come from / go?" — one control, used by every flow
  // that moves money (TMC-207).
  //
  // Renders nothing at all when the company has only its seeded account. That
  // is the common case — most sole traders bank in one place — and asking
  // someone to pick from a list of one is pure noise. The server defaults to
  // the primary account when the field is absent, so omitting the input is not
  // just cosmetic: it is the same code path a pre-TMC-207 form took.

  type MoneyAccount = {
    id: string;
    name: string;
    kind: string | null;
  };

  let {
    accounts,
    name = 'paymentAccountId',
    value = null,
    label = 'Paid from',
    // Cards can be spent FROM but nothing is ever deposited INTO one, so the
    // money-in flows pass false and get bank accounts only.
    allowCards = true,
  }: {
    accounts: MoneyAccount[];
    name?: string;
    value?: string | null;
    label?: string;
    allowCards?: boolean;
  } = $props();

  const KIND_LABEL: Record<string, string> = {
    checking: 'Checking',
    savings: 'Savings',
    cash: 'Cash',
    credit_card: 'Credit card',
  };

  const options = $derived(
    allowCards ? accounts : accounts.filter((a) => a.kind !== 'credit_card'),
  );
</script>

{#if options.length > 1}
  <label class="block">
    <span class="label">{label}</span>
    <select
      {name}
      class="mt-2 w-full max-w-md rounded-sm border border-fg/20 bg-surface px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
    >
      {#each options as a (a.id)}
        <option value={a.id} selected={a.id === value}>
          {a.name}{a.kind ? ` · ${KIND_LABEL[a.kind] ?? ''}` : ''}
        </option>
      {/each}
    </select>
  </label>
{/if}

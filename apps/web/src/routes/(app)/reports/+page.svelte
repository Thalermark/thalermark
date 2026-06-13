<script lang="ts">
  import { may } from '$lib/perms';
  import type { PageProps } from './$types';

  // Reports hub. Static index of the available reports — no data fetch; each
  // card links to a report that loads its own data.
  let { data }: PageProps = $props();

  const reports = [
    {
      href: '/reports/profit-and-loss',
      title: 'Profit & loss',
      blurb: 'Revenue minus expenses — what you actually made over a period.',
    },
    {
      href: '/reports/expenses-by-category',
      title: 'Expenses by category',
      blurb: 'Where the money went, grouped by your Schedule C buckets.',
    },
    {
      href: '/reports/balance-sheet',
      title: 'Balance sheet',
      blurb: 'What you own and owe — assets, liabilities, and equity.',
    },
    {
      href: '/reports/ar-aging',
      title: 'A/R aging',
      blurb: 'Unpaid invoices by how overdue they are — who to chase.',
    },
    {
      href: '/reports/sales-tax',
      title: 'Sales tax collected',
      blurb: 'Tax billed on invoices over a period, ready to remit.',
    },
    {
      href: '/reports/sales-by-customer',
      title: 'Sales by customer',
      blurb: 'Your best customers by revenue over a period.',
    },
    {
      href: '/reports/revenue-over-time',
      title: 'Revenue over time',
      blurb: 'Monthly sales trend across the period.',
    },
    {
      href: '/reports/estimate-win-rate',
      title: 'Estimate win rate',
      blurb: 'How many quotes turn into accepted work.',
    },
    {
      href: '/reports/top-products',
      title: 'Top products',
      blurb: 'Best-selling items and services by revenue.',
    },
  ];
</script>

<div>
  <span class="eyebrow">Reports</span>
  <h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-fg">
    Reports<span class="text-accent">.</span>
  </h1>
</div>

<div class="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
  {#each reports as r (r.href)}
    <a
      href={r.href}
      class="group rounded-sm border border-fg/10 bg-surface-2 p-5 transition-colors hover:border-accent/40 hover:bg-surface"
    >
      <h2 class="font-serif text-xl text-fg group-hover:text-accent">{r.title}</h2>
      <p class="mt-2 text-sm text-fg/60">{r.blurb}</p>
    </a>
  {/each}

  <!-- The general ledger surfaces the hidden double-entry — only for roles that
       can export it (owner / admin / accountant), the same gate the API enforces. -->
  {#if may(data.role, 'reports:export')}
    <a
      href="/reports/general-ledger"
      class="group rounded-sm border border-fg/10 bg-surface-2 p-5 transition-colors hover:border-accent/40 hover:bg-surface"
    >
      <h2 class="font-serif text-xl text-fg group-hover:text-accent">General ledger</h2>
      <p class="mt-2 text-sm text-fg/60">
        Every journal entry behind your books — the full double-entry detail, ready for your
        accountant or tax software.
      </p>
    </a>
  {/if}
</div>

<script lang="ts">
  // Reports hub. Static index of the available reports — no data fetch; each
  // card links to a report that loads its own data.
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
  <h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-ink">
    Reports<span class="text-gold-deep">.</span>
  </h1>
</div>

<div class="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
  {#each reports as r (r.href)}
    <a
      href={r.href}
      class="group rounded-sm border border-ink/10 bg-cream-warm p-5 transition-colors hover:border-gold-deep/40 hover:bg-cream"
    >
      <h2 class="font-serif text-xl text-ink group-hover:text-gold-deep">{r.title}</h2>
      <p class="mt-2 text-sm text-ink/60">{r.blurb}</p>
    </a>
  {/each}
</div>

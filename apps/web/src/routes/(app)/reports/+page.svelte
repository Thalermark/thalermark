<script lang="ts">
  import { may } from '$lib/perms';
  import { type BusinessType, TAX_FORM_BY_BUSINESS_TYPE } from '@thalermark/validation';
  import type { PageProps } from './$types';

  // Reports hub. Static index of the available reports — no data fetch; each
  // card links to a report that loads its own data.
  let { data }: PageProps = $props();

  // All five business types have a worksheet as of TMC-162, so the card is
  // always shown — but it's named for the return this business actually files,
  // because "Schedule C worksheet" means nothing to an S-corp. An unresolved
  // business type falls back to the generic wording; the page itself always
  // names the form. `activeBusinessType` comes from the (app) layout load.
  const businessType = $derived(data.activeBusinessType as BusinessType | null);
  const taxForm = $derived(businessType ? TAX_FORM_BY_BUSINESS_TYPE[businessType] : null);

  const reports = $derived([
    {
      href: '/reports/profit-and-loss',
      title: 'Profit & loss',
      blurb: 'Revenue minus expenses — what you actually made over a period.',
    },
    {
      href: '/reports/expenses-by-category',
      title: 'Expenses by category',
      blurb: 'Where the money went, grouped by category.',
    },
    {
      href: '/reports/tax-worksheet',
      title: taxForm ? `${taxForm} worksheet` : 'Tax worksheet',
      blurb: 'Your year laid out by tax line, ready to hand to whoever files for you.',
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
      title: 'Sales by contact',
      blurb: 'Your best contacts by revenue over a period.',
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
  ]);
</script>

<div>
  <span class="eyebrow">Reports</span>
  <h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-fg">
    Reports<span class="text-accent">.</span>
  </h1>
</div>

<!-- Year-end close prompt. The action lives behind The Ledger's airlock, which
     someone who never opens that portal would never find — so the reminder goes
     where people actually land at tax time. Only rendered for roles that can act
     on it (see the loader). -->
{#if data.unclosedYear}
  <div class="callout mt-8">
    <p class="text-sm text-fg/70">
      <span class="text-fg">{data.unclosedYear} is ready to close out.</span>
      Closing a year moves its profit into your equity and locks it so nothing can change it.
      <a href="/ledger/close" class="link">Close out {data.unclosedYear}</a>.
    </p>
  </div>
{/if}

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

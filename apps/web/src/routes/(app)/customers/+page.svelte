<script lang="ts">
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
</script>

<span class="eyebrow">Customers</span>
<h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-ink">
  All customers<span class="text-gold-deep">.</span>
</h1>

{#if data.customers.length === 0}
  <p class="mt-8 text-ink/70">No customers yet.</p>
{:else}
  <ul class="mt-8 divide-y divide-ink/10 rounded-sm border border-ink/10 bg-cream-warm">
    {#each data.customers as c (c.id)}
      <li>
        <a
          href="/customers/{c.id}"
          class="flex items-center justify-between px-5 py-4 transition-colors hover:bg-cream"
        >
          <span class="font-serif text-lg text-ink">{c.name}</span>
          <span class="font-mono text-xs uppercase tracking-widest text-ink/50">
            {c.email ?? ''}
          </span>
        </a>
      </li>
    {/each}
  </ul>
{/if}

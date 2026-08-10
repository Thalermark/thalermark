<script lang="ts">
  import { enhance } from '$app/forms';
  import { may } from '$lib/perms';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();

  const canAdjust = $derived(may(data.role, 'ledger:adjust'));

  const money = (s: string) =>
    Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  // Which year's confirm panel is open. Closing a year is irreversible-ish
  // (re-opening is possible but deliberate), so it never happens on one click.
  let confirming = $state<number | null>(null);
  let submitting = $state(false);
</script>

<div>
  <span class="eyebrow text-accent">The Ledger</span>
  <h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-fg">
    Close out a year<span class="text-accent">.</span>
  </h1>
</div>

<p class="mt-4 max-w-2xl text-sm text-fg/60">
  Closing a year moves its profit into your business's equity and locks the year, so nothing can
  change it afterwards. Most people do this once their accountant has finished the tax return.
</p>

<!--
  A LINK, not a copy of the form. The vehicle answers are deliberately NOT
  period-locked, so they can be given before or after a close — which means this
  page has no reason to own them, and a second copy of the form would be a second
  thing to keep correct. Pointing at the worksheet also lands the user where the
  rest of the return is.
-->
{#if data.vehiclesNeedingAnswers > 0}
  <p class="callout mt-6 text-sm text-fg/70">
    Before you close: {data.vehiclesNeedingAnswers === 1
      ? 'one of your vehicles is'
      : `${data.vehiclesNeedingAnswers} of your vehicles are`} missing details the return needs.
    <a href="/reports/tax-worksheet" class="link">Finish that first</a> — you can still answer it
    after closing, but it's easier while the year is in front of you.
  </p>
{/if}

{#if form?.formError}
  <div class="callout mt-6 border-danger/40 text-danger" data-form-error role="alert" tabindex="-1">{form.formError}</div>
{/if}
{#if form?.closedYear}
  <div class="callout mt-6">{form.closedYear} is closed.</div>
{/if}
{#if form?.reopenedYear}
  <div class="callout mt-6">{form.reopenedYear} is open again.</div>
{/if}

<h2 class="mt-10 font-serif text-2xl font-light text-fg">Ready to close</h2>

{#if data.closable.length === 0}
  <p class="mt-4 text-sm text-fg/70">
    Nothing to close right now. A year can be closed once it's over.
  </p>
{:else}
  <div class="mt-4 space-y-4">
    {#each data.closable as year (year.fiscalYear)}
      <div class="rounded-sm border border-fg/10 bg-surface-2 p-6">
        <div class="flex flex-wrap items-baseline justify-between gap-4">
          <div>
            <h3 class="font-serif text-xl text-fg">{year.fiscalYear}</h3>
            <p class="mt-1 text-sm text-fg/70">
              {Number(year.netIncome) < 0 ? 'Loss' : 'Profit'} of
              <span class="font-mono tabular-nums text-fg"
                >{money(String(Math.abs(Number(year.netIncome))))}</span
              >
              {#if Number(year.withdrawals) > 0}
                · <span class="font-mono tabular-nums text-fg">{money(year.withdrawals)}</span> taken
                out
              {/if}
            </p>
          </div>
          {#if canAdjust}
            <button
              type="button"
              class="btn"
              onclick={() => (confirming = confirming === year.fiscalYear ? null : year.fiscalYear)}
            >
              {confirming === year.fiscalYear ? 'Cancel' : `Close ${year.fiscalYear}`}
            </button>
          {/if}
        </div>

        {#if confirming === year.fiscalYear}
          <div class="mt-5 border-t border-fg/10 pt-5">
            <p class="text-sm leading-relaxed text-fg/80">
              This locks {year.fiscalYear} so nothing can change it, and moves the year's
              {Number(year.netIncome) < 0 ? 'loss' : 'profit'} into
              <strong class="font-medium text-fg">{year.equityLabel.toLowerCase()}</strong>. If you
              need to add or fix something in {year.fiscalYear} later, you can re-open it here.
            </p>
            <form
              method="POST"
              action="?/close"
              class="mt-5"
              use:enhance={() => {
                submitting = true;
                return async ({ update }) => {
                  await update();
                  submitting = false;
                  confirming = null;
                };
              }}
            >
              <input type="hidden" name="fiscalYear" value={year.fiscalYear} />
              <button type="submit" class="btn" disabled={submitting}>
                {submitting ? 'Closing…' : `Yes, close ${year.fiscalYear}`}
              </button>
            </form>
          </div>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<!-- Years with no activity aren't given a card of their own — there's nothing to
     close and no button to press. Naming them in one line answers "why isn't 2023
     listed?" without turning the page into a stack of empty boxes. -->
{#if data.emptyYears.length > 0}
  <p class="mt-4 text-sm text-fg/50">
    Nothing on the books for {new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(
      data.emptyYears.map(String),
    )}.
  </p>
{/if}

{#if data.closes.length > 0}
  <h2 class="mt-12 font-serif text-2xl font-light text-fg">Closed years</h2>
  <div class="mt-4 overflow-hidden rounded-sm border border-fg/10 bg-surface-2">
    <table class="w-full text-left text-sm">
      <thead class="bg-surface">
        <tr class="label">
          <th class="px-5 py-3">Year</th>
          <!-- "Profit or loss": a closed year can be either, and the column
               happily shows a negative. -->
          <th class="px-5 py-3 text-right">Profit or loss</th>
          <th class="px-5 py-3">Closed on</th>
          <th class="px-5 py-3"></th>
        </tr>
      </thead>
      <tbody class="divide-y divide-fg/10">
        {#each data.closes as row (row.id)}
          <tr>
            <td class="px-5 py-4 font-mono tabular-nums text-fg">{row.fiscalYear}</td>
            <td class="px-5 py-4 text-right font-mono tabular-nums text-fg/80">
              {money(row.netIncome)}
            </td>
            <td class="px-5 py-4 font-mono tabular-nums text-fg/60">{row.closedAt}</td>
            <td class="px-5 py-4 text-right">
              <!-- Only the most recent close can be re-opened: an earlier year
                   would stay locked by the later one anyway. -->
              {#if canAdjust && row.id === data.reopenableId}
                <form method="POST" action="?/reopen" use:enhance>
                  <input type="hidden" name="id" value={row.id} />
                  <button type="submit" class="link text-sm">Re-open</button>
                </form>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

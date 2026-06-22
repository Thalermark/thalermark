<script lang="ts">
  import { estimatePasswordStrength } from '@thalermark/validation';

  let { password }: { password: string } = $props();

  const strength = $derived(estimatePasswordStrength(password));

  // Band index -> segment fill + text color. Semantic status tokens, so the
  // meter re-tints correctly in dark mode (see app.css :root vs .dark).
  const fills = ['bg-danger', 'bg-warning', 'bg-accent', 'bg-success'];
  const texts = ['text-danger', 'text-warning', 'text-accent', 'text-success'];
</script>

{#if password.length > 0}
  <div class="mt-2 space-y-1.5">
    <div class="flex gap-1">
      {#each [0, 1, 2, 3] as i (i)}
        <span
          class="h-1 flex-1 rounded-full transition-colors {i <= strength.score
            ? fills[strength.score]
            : 'bg-fg/15'}"
        ></span>
      {/each}
    </div>
    <p class="label {texts[strength.score]}" aria-live="polite">{strength.label}</p>
    {#if strength.score < 3}
      <p class="text-xs text-fg/55">A few random words make the strongest password.</p>
    {/if}
  </div>
{/if}

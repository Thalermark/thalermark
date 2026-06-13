<script lang="ts">
  type Props = {
    name: string;
    email: string;
    size?: 'sm' | 'md';
  };

  let { name, email, size = 'md' }: Props = $props();

  const seed = $derived((name || email || '').trim());
  const initials = $derived(deriveInitials(seed));

  function deriveInitials(s: string): string {
    if (!s) return '?';
    const parts = s.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase();
    }
    return (parts[0]?.[0] ?? '?').toUpperCase();
  }

  const dimensions = $derived(size === 'sm' ? 'h-7 w-7 text-xs' : 'h-9 w-9 text-sm');
</script>

<span
  aria-hidden="true"
  class={`inline-flex items-center justify-center rounded-full bg-inverse font-medium text-on-inverse ${dimensions}`}
>
  {initials}
</span>

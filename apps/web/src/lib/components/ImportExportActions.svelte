<script lang="ts">
  import { type ImportEntityKey, entityByKey } from '$lib/import/descriptors';
  import { may } from '$lib/perms';
  import type { Role } from '@thalermark/validation';

  // Export + Import buttons for a list page header. Export is a plain download
  // link (read action — visible to anyone who can see the list). Import jumps to
  // the import hub with this entity pre-selected, gated on the entity's write
  // cap to match the page's own "+ New" gate. Both routes derive from the
  // descriptor so adding an importable entity needs no change here.
  let { entity, role }: { entity: ImportEntityKey; role: Role | undefined } = $props();
  const def = $derived(entityByKey(entity));
</script>

<a href="{def.href}/export" class="btn-ghost" download>Export</a>
{#if may(role, def.cap)}
  <a href="/settings/import?entity={entity}" class="btn-ghost">Import</a>
{/if}

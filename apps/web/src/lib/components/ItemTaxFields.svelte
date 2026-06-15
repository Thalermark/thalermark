<script lang="ts">
  // Taxable toggle + default tax-policy picker for the item create/edit forms.
  // The policy is "applied only when taxable" — readForm on the server only
  // attaches taxPolicyId when the box is checked, so the stored data can't
  // disagree with the toggle. Both inputs post as plain form fields (taxable as
  // a checkbox, taxPolicyId as a select), so the no-JS path still works.
  type Policy = { id: string; name: string; ratePct: string };
  let {
    taxPolicies,
    taxable = false,
    policyId = '',
  }: { taxPolicies: Policy[]; taxable?: boolean; policyId?: string } = $props();

  const rate = (s: string) => `${Number(s)}%`;
</script>

<div class="space-y-3 rounded-sm border border-fg/10 bg-surface-2 p-4">
  <label class="flex items-center gap-3 text-sm text-fg/80">
    <input type="checkbox" name="taxable" checked={taxable} class="size-4 accent-accent" />
    Taxable — charge sales tax when this item is on an invoice
  </label>

  {#if taxPolicies.length > 0}
    <div class="max-w-sm">
      <label for="taxPolicyId" class="label">Tax policy</label>
      <select id="taxPolicyId" name="taxPolicyId" class="field mt-1">
        <option value="" selected={policyId === ''}>Company default</option>
        {#each taxPolicies as p (p.id)}
          <option value={p.id} selected={policyId === p.id}>{p.name} · {rate(p.ratePct)}</option>
        {/each}
      </select>
      <p class="mt-1 text-xs text-fg/50">
        Applied only when taxable. Leave as “Company default” to use the default rate at invoice
        time.
      </p>
    </div>
  {:else}
    <p class="text-xs text-fg/50">
      No tax policies yet. <a href="/settings/tax-policies/new" class="link">Create one</a> to charge
      a specific rate.
    </p>
  {/if}
</div>

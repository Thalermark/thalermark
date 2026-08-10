<script lang="ts">
  import { enhance } from '$app/forms';
  import { enhanceForm } from '$lib/form-enhance';
    import type { PageProps } from './$types';

  let { form, data }: PageProps = $props();
  const values = $derived(form?.values ?? {});
  const fieldErrors = $derived(form?.fieldErrors ?? {});

  type FieldKey = 'name' | 'contactId' | 'startedOn' | 'endedOn';
  function v(key: FieldKey): string {
    const raw = (values as Record<string, unknown>)[key];
    return typeof raw === 'string' ? raw : '';
  }
  function err(key: FieldKey): string | undefined {
    return (fieldErrors as Record<string, string>)[key];
  }
  // The date-order refine has no field path, so it surfaces under the '_' key.
  const dateError = $derived((fieldErrors as Record<string, string>)._);
</script>

<a href="/jobs" class="eyebrow text-fg/60 hover:text-fg">← Jobs</a>
<h1 class="mt-3 font-serif text-4xl font-light leading-none tracking-tight text-fg">
  New job<span class="text-accent">.</span>
</h1>

{#if form?.formError}
  <div class="mt-6 rounded-sm border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger" data-form-error role="alert" tabindex="-1">
    {form.formError}
  </div>
{/if}

<form method="post" class="mt-8 space-y-6" use:enhance={enhanceForm}>
  <div>
    <label for="name" class="label">
      What do you call it<span class="text-accent">*</span>
    </label>
    <input
      id="name"
      name="name"
      type="text"
      required
      maxlength="200"
      placeholder="The Smith job"
      value={v('name')}
      class="field mt-1"
    />
    <p class="mt-1 text-xs text-fg/50">
      Whatever you'd say out loud. It only has to make sense to you.
    </p>
    {#if err('name')}
      <p class="mt-1 text-xs text-danger">{err('name')}</p>
    {/if}
  </div>

  <div>
    <label for="contactId" class="label">Customer</label>
    <select id="contactId" name="contactId" class="field mt-1">
      <option value="">— none —</option>
      {#each data.contacts as contact (contact.id)}
        <option value={contact.id} selected={v('contactId') === contact.id}>{contact.name}</option>
      {/each}
    </select>
    <p class="mt-1 text-xs text-fg/50">Optional. A job doesn't need one to be useful.</p>
  </div>

  <div class="grid gap-6 sm:grid-cols-2">
    <div>
      <label for="startedOn" class="label">Started</label>
      <input
        id="startedOn"
        name="startedOn"
        type="date"
        value={v('startedOn')}
        class="field mt-1"
      />
    </div>
    <div>
      <label for="endedOn" class="label">Ended</label>
      <input id="endedOn" name="endedOn" type="date" value={v('endedOn')} class="field mt-1" />
    </div>
  </div>
  {#if dateError}
    <p class="text-xs text-danger">
      {dateError === 'ended_before_started' ? "The end date is before the start date." : dateError}
    </p>
  {/if}

  <div class="flex items-center gap-4">
    <button type="submit" class="btn">Create job</button>
    <a href="/jobs" class="link">Cancel</a>
  </div>
</form>

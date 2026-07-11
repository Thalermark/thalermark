<script lang="ts">
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();

  // Local form state, seeded from the stored connection. Driving the provider
  // picker in the client decides which fields show (key / endpoint / models).
  const initialProvider = $derived(
    data.unavailable ? '' : (data.connection?.provider ?? data.presets[0]?.id ?? 'anthropic'),
  );
  let selectedProvider = $state('');
  $effect(() => {
    if (!selectedProvider) selectedProvider = initialProvider;
  });

  const presets = $derived(data.unavailable ? [] : data.presets);
  const preset = $derived(presets.find((p) => p.id === selectedProvider));
  const needsKey = $derived(preset?.needsKey ?? true);
  const showBaseUrl = $derived(!!preset && (preset.requiresBaseUrl || preset.baseUrl != null));
  const connection = $derived(data.unavailable ? null : data.connection);
  // Operator SSRF config, read-only. Lets the endpoint hint say what the server
  // permits instead of a bare "blocked".
  const allowedEndpoints = $derived(data.unavailable ? [] : (data.allowedEndpoints ?? []));

  let showAdvanced = $state(false);

  // Chip: the one glance that says whether AI is on. Status comes from the API
  // (derived from the health columns), never guessed here.
  type Chip = { text: string; cls: string };
  const chip = $derived.by((): Chip => {
    switch (connection?.status) {
      case 'ready':
        return { text: 'AI ready', cls: 'bg-success/15 text-success' };
      case 'unverified':
        return { text: 'Verify to enable AI', cls: 'bg-warning/15 text-warning' };
      case 'error':
        return { text: 'Needs attention', cls: 'bg-danger/15 text-danger' };
      default:
        return { text: 'Not configured', cls: 'bg-fg/10 text-fg/60' };
    }
  });

  const saved = $derived(form && 'saved' in form ? form.saved : false);
  const errorMsg = $derived(form && 'error' in form ? form.error : null);
  const verify = $derived(form && 'verify' in form ? form.verify : null);

  function ago(iso: string | null): string {
    if (!iso) return '';
    const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (secs < 60) return 'just now';
    if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
    if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
    return `${Math.round(secs / 86400)}d ago`;
  }
</script>

<h1 class="font-serif text-4xl font-light leading-none tracking-tight text-fg">
  AI<span class="text-accent">.</span>
</h1>
<p class="mt-4 max-w-prose text-sm leading-relaxed text-fg/70">
  AI powers receipt auto-fill, expense categorization, and cash-flow nudges. Connect a provider,
  verify it, and it turns on for everyone in this workspace. Your key is stored encrypted and never
  shown again.
</p>

{#if data.unavailable}
  <div class="callout mt-8">AI is not available on this server.</div>
{:else}
  <div class="mt-6 flex items-center gap-3">
    <span
      class="inline-block rounded-sm px-2 py-0.5 font-mono text-[0.65rem] uppercase tracking-widest {chip.cls}"
    >
      {chip.text}
    </span>
    {#if connection?.status === 'ready' && connection.lastOkAt}
      <span class="text-xs text-fg/50">last ok {ago(connection.lastOkAt)}</span>
    {/if}
  </div>

  {#if connection?.status === 'unverified'}
    <p class="mt-3 text-sm text-warning">
      Saved, but not verified — AI stays off until you click <strong>Verify</strong>.
    </p>
  {:else if connection?.status === 'error' && connection.lastError}
    <p class="mt-3 max-w-prose text-sm text-danger">{connection.lastError}</p>
  {/if}

  {#if verify}
    <div class="callout mt-4">
      {#if verify.ok}
        Verified — AI is live{'latencyMs' in verify && verify.latencyMs
          ? ` (responded in ${verify.latencyMs} ms)`
          : ''}.
      {:else}
        Verification failed: {verify.error}
      {/if}
    </div>
  {/if}

  <form method="POST" action="?/save" class="mt-8 max-w-xl space-y-6">
    <div>
      <label class="label" for="provider">Provider</label>
      <select id="provider" name="provider" bind:value={selectedProvider} class="field mt-2">
        {#each presets as p (p.id)}
          <option value={p.id}>{p.label}</option>
        {/each}
      </select>
    </div>

    {#if showBaseUrl}
      <div>
        <label class="label" for="baseUrl">Endpoint URL</label>
        <input
          id="baseUrl"
          name="baseUrl"
          type="url"
          class="field mt-2"
          placeholder={preset?.baseUrl ?? 'https://…/v1'}
          value={connection?.baseUrl ?? ''}
        />
        {#if allowedEndpoints.length > 0}
          <p class="mt-1 text-xs text-fg/50">
            Your server allows these private endpoints:
            {#each allowedEndpoints as ep, i (ep)}<code>{ep}</code>{i <
              allowedEndpoints.length - 1
              ? ', '
              : ''}{/each}. Others on a private/LAN address are blocked.
          </p>
        {:else if data.allowPrivate}
          <p class="mt-1 text-xs text-fg/50">
            This server allows private/LAN endpoints (e.g. a local Ollama).
          </p>
        {:else}
          <p class="mt-1 text-xs text-fg/50">
            Private/LAN addresses are blocked. Your server administrator can allow one by setting
            <code>AI_ALLOWED_ENDPOINTS</code> (or open all with
            <code>AI_ALLOW_PRIVATE_ENDPOINTS</code>).
          </p>
        {/if}
      </div>
    {/if}

    {#if needsKey}
      <div>
        <label class="label" for="apiKey">API key</label>
        <input
          id="apiKey"
          name="apiKey"
          type="password"
          autocomplete="off"
          class="field mt-2"
          placeholder={connection?.hasKey ? connection.keyHint ?? '••••' : 'Paste your key'}
        />
        {#if connection?.hasKey}
          <p class="mt-1 text-xs text-fg/50">A key is stored. Leave blank to keep it.</p>
        {/if}
      </div>
    {/if}

    <div>
      <button type="button" class="text-xs text-fg/60 hover:text-fg" onclick={() => (showAdvanced = !showAdvanced)}>
        {showAdvanced ? '– Hide' : '+ Advanced'} model overrides
      </button>
      {#if showAdvanced}
        <div class="mt-3 space-y-4 rounded-sm border border-fg/15 bg-surface-2 p-4">
          <p class="text-xs text-fg/50">
            Leave blank for this provider's defaults. Roles map by task, not vendor.
          </p>
          {#each [{ name: 'modelVision', label: 'Vision (reads receipts)', key: 'vision' }, { name: 'modelReasoning', label: 'Reasoning (nudges)', key: 'reasoning' }, { name: 'modelFast', label: 'Fast (categorization)', key: 'fast' }] as m (m.name)}
            <div>
              <label class="label" for={m.name}>{m.label}</label>
              <input
                id={m.name}
                name={m.name}
                type="text"
                class="field mt-2"
                placeholder={preset?.models?.[m.key as 'vision' | 'reasoning' | 'fast'] ?? ''}
                value={m.name === 'modelVision'
                  ? (connection?.modelVision ?? '')
                  : m.name === 'modelReasoning'
                    ? (connection?.modelReasoning ?? '')
                    : (connection?.modelFast ?? '')}
              />
            </div>
          {/each}
        </div>
      {/if}
    </div>

    {#if errorMsg}
      <p class="text-sm text-danger">{errorMsg}</p>
    {/if}
    {#if saved}
      <p class="text-sm text-success">Saved. Click Verify to turn AI on.</p>
    {/if}

    <div class="flex items-center gap-3">
      <button type="submit" class="btn">Save</button>
      {#if connection}
        <button type="submit" formaction="?/verify" class="btn-ghost">Verify</button>
        <button
          type="submit"
          formaction="?/remove"
          class="btn-ghost btn-sm text-danger hover:border-danger hover:text-danger"
        >
          Remove
        </button>
      {/if}
    </div>
  </form>
{/if}

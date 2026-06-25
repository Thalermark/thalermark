<script lang="ts">
  // Compiled in at build time (Vite `define`, fed by the git tag / APP_VERSION
  // build-arg). No runtime env, no API call — it's the version of this build.
  const version = __APP_VERSION__;
</script>

<h1 class="font-serif text-4xl font-light leading-none tracking-tight text-fg">
  About<span class="text-accent">.</span>
</h1>

<section class="mt-8 rounded-sm border border-fg/15 bg-surface-2">
  <header class="border-b border-fg/10 px-6 py-5">
    <span class="eyebrow">Version</span>
    <p class="mt-2 text-sm text-fg/70">The release running on this installation.</p>
  </header>
  <dl class="grid gap-4 px-6 py-6 text-sm">
    <div class="flex items-center justify-between gap-4">
      <dt class="text-fg/60">Thalermark</dt>
      <dd class="font-mono text-fg">{version}</dd>
    </div>
  </dl>
</section>

<script lang="ts">
  let { children } = $props();
</script>

<div class="flex min-h-screen flex-col">
  <nav class="px-6 py-8">
    <div class="mx-auto max-w-5xl">
      <a href="/" class="wordmark wordmark-small text-ink" aria-label="Thalermark home">
        <span class="strike"></span>
        <span class="word">thalermark</span>
      </a>
    </div>
  </nav>

  <main class="flex flex-1 items-center justify-center px-4 pb-16">
    <div class="w-full max-w-sm">
      {@render children()}
    </div>
  </main>
</div>

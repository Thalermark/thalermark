<script lang="ts">
  import { PRODUCT_NAME } from '@thalermark/brand';

  let { children } = $props();
</script>

<main class="flex min-h-screen items-center justify-center bg-primary-50 px-4 py-12">
  <div class="w-full max-w-sm">
    <h1 class="mb-6 text-center text-2xl font-semibold tracking-tight text-primary-900">
      {PRODUCT_NAME}
    </h1>
    <div class="rounded-lg border border-primary-200 bg-white p-6 shadow-sm">
      {@render children()}
    </div>
  </div>
</main>

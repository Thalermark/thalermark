<script lang="ts">
  // First-run telemetry consent prompt (TELEMETRY.md). Rendered by the (app)
  // layout when the account hasn't decided yet and the deployment hasn't
  // disabled telemetry. Two plain HTML forms post to /telemetry-consent (a
  // layout-level endpoint, since form actions are page-scoped) and redirect
  // back, so the choice sticks with no client JS.
</script>

<div class="callout mb-8 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
  <div>
    <p class="font-serif text-base text-fg">Help us build a better product</p>
    <p class="mt-1 text-fg/70">
      We'd like to collect anonymous usage data — which features you use and where errors occur. We
      never collect personal or financial information. You can opt out any time in Settings →
      Privacy.
    </p>
  </div>
  <div class="flex shrink-0 items-center gap-3">
    <form method="POST" action="/telemetry-consent">
      <input type="hidden" name="enabled" value="on" />
      <button type="submit" class="btn">Yes, help</button>
    </form>
    <form method="POST" action="/telemetry-consent">
      <button type="submit" class="btn-ghost">No thanks</button>
    </form>
  </div>
</div>

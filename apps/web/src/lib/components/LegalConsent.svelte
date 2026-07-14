<script lang="ts">
  // Blocking legal-consent wall (spikes/SIGN-UP-ACK-TOS.md). The (app) layout
  // renders this IN PLACE OF the app when the deployment requires Terms/Privacy
  // consent and the signed-in user hasn't accepted the current version. A plain
  // HTML form posts to /legal-accept (a layout-level endpoint — SvelteKit form
  // actions are page-scoped) which records the acceptance and redirects back, so
  // it works with no client JS. The checkbox is `required`, so the browser itself
  // blocks submit until it's ticked — that tick is the clickwrap act. This gates
  // app ENTRY, not the sign-up form, which is why it covers every door (email,
  // social, invite, mobile): the social OAuth callback has no form body to carry
  // a checkbox, so a post-sign-up wall is the one mechanism that reaches them all.
  let { termsUrl, privacyUrl }: { termsUrl: string; privacyUrl: string } = $props();
</script>

<section class="mx-auto max-w-lg">
  <div class="rounded-sm border border-fg/15 bg-surface-2 px-6 py-8">
    <span class="eyebrow">One quick thing</span>
    <h1 class="mt-2 font-serif text-3xl font-light leading-none tracking-tight text-fg">
      Before you continue<span class="text-accent">.</span>
    </h1>
    <p class="mt-4 text-sm text-fg/70">
      To use Thalermark, please review and accept our terms. It keeps your account and ours on the
      same page.
    </p>
    <form method="POST" action="/legal-accept" class="mt-6">
      <label class="flex items-start gap-3 text-sm text-fg/80">
        <input type="checkbox" name="agree" required class="mt-1" />
        <span>
          I agree to the
          <a class="link" href={termsUrl} target="_blank" rel="noopener">Terms of Service</a>
          and
          <a class="link" href={privacyUrl} target="_blank" rel="noopener">Privacy Policy</a>.
        </span>
      </label>
      <button type="submit" class="btn mt-6 w-full py-3">Agree &amp; continue</button>
    </form>
  </div>
</section>

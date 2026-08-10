<script lang="ts">
  import { DOMAIN, PRODUCT_NAME, TAGLINE } from '@thalermark/brand';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  // Compiled in at build time (Vite `define`, fed by the git tag / APP_VERSION
  // build-arg). No runtime env, no API call — it's the version of this build.
  const version = __APP_VERSION__;

  const siteUrl = `https://${DOMAIN}`;
  const sourceUrl = 'https://github.com/Thalermark/thalermark';
</script>

<h1 class="font-serif text-4xl font-light leading-none tracking-tight text-fg">
  About<span class="text-accent">.</span>
</h1>

{#if data.usingBundledTemplates}
  <!-- Shows only when consent is REQUIRED and the URLs still point at the
       bundled pages. Leaving consent off is a legitimate choice and warns
       about nothing; turning it on and forgetting the documents is the case
       worth interrupting someone for (TMC-214). Not a boot failure, and the
       example pages stay in the repo — both deliberate. -->
  <div class="mt-6 max-w-prose rounded-sm border border-warning/40 bg-warning/5 px-6 py-5">
    <p class="font-serif text-lg text-fg">Your users are agreeing to example documents.</p>
    <p class="mt-2 text-sm leading-relaxed text-fg/70">
      Everyone signing in here has to accept your Terms and Privacy Policy before they can use the
      app — but this installation is still pointing at the sample pages that ship with
      {PRODUCT_NAME}. They read <span class="font-mono text-xs">[Operator legal name]</span> and
      <span class="font-mono text-xs">[jurisdiction]</span>, because they are a starting point for
      you to rewrite, not a licence to use.
    </p>
    <p class="mt-2 text-sm leading-relaxed text-fg/70">
      Replace them with your own, then point
      <span class="font-mono text-xs">LEGAL_TERMS_URL</span> and
      <span class="font-mono text-xs">LEGAL_PRIVACY_URL</span> at them and bump
      <span class="font-mono text-xs">LEGAL_TERMS_VERSION</span> so everyone is asked again. If you
      did not mean to collect consent at all, unset
      <span class="font-mono text-xs">LEGAL_CONSENT_REQUIRED</span>.
    </p>
    <p class="mt-2 text-sm leading-relaxed text-fg/60">
      This notice is for whoever runs this server. Nothing is broken and nobody is blocked.
    </p>
  </div>
{/if}

<section class="mt-8 rounded-sm border border-fg/15 bg-surface-2">
  <header class="border-b border-fg/10 px-6 py-5">
    <span class="eyebrow">Overview</span>
    <p class="mt-2 text-sm text-fg/70">{TAGLINE}</p>
  </header>
  <div class="px-6 py-6 text-sm leading-relaxed text-fg/80">
    <p class="max-w-prose">
      {PRODUCT_NAME} is built for people who'd rather be doing the work than the books — landscapers,
      dog sitters, power washers, independent contractors. Send an invoice in under a minute, snap a
      receipt to log an expense, and let the AI explain what's happening in plain English. There's a
      real double-entry ledger underneath, but you'll never see a debit or a credit — just invoices,
      expenses, and answers.
    </p>
  </div>
</section>

<section class="mt-6 rounded-sm border border-fg/15 bg-surface-2">
  <header class="border-b border-fg/10 px-6 py-5">
    <span class="eyebrow">The name</span>
  </header>
  <div class="px-6 py-6 text-sm leading-relaxed text-fg/80">
    <p>
      The name draws on two old words for money. The <em>thaler</em> was the 16th-century silver
      coin whose name became the root of the word “dollar.” A <em>mark</em> was the stamp pressed
      into a coin to certify it was genuine. Put them together and you have the idea behind the
      product: every transaction, authenticated.
    </p>
  </div>
</section>

<section class="mt-6 rounded-sm border border-fg/15 bg-surface-2">
  <header class="border-b border-fg/10 px-6 py-5">
    <span class="eyebrow">Open source</span>
  </header>
  <div class="px-6 py-6 text-sm leading-relaxed text-fg/80">
    <p>
      {PRODUCT_NAME} is open source, released under the GNU Affero General Public License v3. Read
      the code, self-host it, or make it your own.
    </p>
    <div class="mt-4 flex flex-wrap gap-x-6 gap-y-2">
      <a class="link" href={siteUrl} target="_blank" rel="noreferrer noopener">{DOMAIN}</a>
      <a class="link" href={sourceUrl} target="_blank" rel="noreferrer noopener">
        Source code on GitHub
      </a>
    </div>
  </div>
</section>

<section class="mt-6 rounded-sm border border-fg/15 bg-surface-2">
  <header class="border-b border-fg/10 px-6 py-5">
    <span class="eyebrow">Version</span>
    <p class="mt-2 text-sm text-fg/70">The release running on this installation.</p>
  </header>
  <dl class="grid gap-4 px-6 py-6 text-sm">
    <div class="flex items-center justify-between gap-4">
      <dt class="text-fg/60">{PRODUCT_NAME}</dt>
      <dd class="font-mono text-fg">{version}</dd>
    </div>
  </dl>
</section>

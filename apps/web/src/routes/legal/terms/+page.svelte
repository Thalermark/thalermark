<script lang="ts">
  // TEMPLATE Terms of Service shipped with the self-host bundle so the sign-up
  // legal-consent clickwrap (PUBLIC_TERMS_URL) has something to link to out of
  // the box. It is deliberately generic boilerplate — NOT legal advice and not
  // specific to any operator. Every deploy that opens sign-up to real users must
  // review + customize this with counsel, or point PUBLIC_TERMS_URL at its own
  // hosted page. Bracketed [placeholders] mark what an operator fills in.
</script>

<svelte:head>
  <title>Terms of Service</title>
  <meta name="robots" content="noindex" />
</svelte:head>

<div class="mx-auto max-w-3xl px-6 py-12 sm:py-20">
  <div class="mb-10 rounded border border-accent/40 bg-accent/[0.06] p-4 text-sm text-fg/80">
    <p class="font-semibold text-fg">Template — customize before launch.</p>
    <p class="mt-1">
      This is placeholder boilerplate that ships with the self-hosted app, not legal advice. Review
      it with your own counsel and replace the bracketed placeholders before opening sign-up to real
      users, or point <code class="font-mono text-xs">PUBLIC_TERMS_URL</code> at your own page.
    </p>
  </div>

  <h1 class="font-serif text-3xl font-light tracking-tight text-fg">Terms of Service</h1>
  <p class="mt-2 font-mono text-xs uppercase tracking-widest text-fg/50">
    Last updated: [DATE]
  </p>

  <div class="mt-10 space-y-8 text-sm leading-relaxed text-fg/80">
    <section>
      <h2 class="font-serif text-lg text-fg">1. Agreement</h2>
      <p class="mt-2">
        These Terms govern your access to and use of the service operated by
        <strong>[Operator legal name]</strong> ("we", "us") at <strong>[your domain]</strong> (the
        "Service"). By creating an account or using the Service you agree to these Terms. If you do
        not agree, do not use the Service.
      </p>
    </section>

    <section>
      <h2 class="font-serif text-lg text-fg">2. The Service</h2>
      <p class="mt-2">
        The Service is an accounting and invoicing tool for freelancers and small businesses. We may
        add, change, or remove features over time. The Service is provided on an "as is" and "as
        available" basis.
      </p>
    </section>

    <section>
      <h2 class="font-serif text-lg text-fg">3. Accounts &amp; eligibility</h2>
      <p class="mt-2">
        You must be at least 18 and able to form a binding contract. You are responsible for the
        activity under your account and for keeping your credentials secure. Notify us promptly of
        any unauthorized use.
      </p>
    </section>

    <section>
      <h2 class="font-serif text-lg text-fg">4. Acceptable use</h2>
      <p class="mt-2">
        You agree not to misuse the Service — no unlawful activity, no attempts to breach security
        or access data that is not yours, no interference with other users, and no use that violates
        applicable law. We may suspend accounts that do.
      </p>
    </section>

    <section>
      <h2 class="font-serif text-lg text-fg">5. Your data</h2>
      <p class="mt-2">
        You retain ownership of the financial and business data you enter. You grant us the limited
        rights needed to operate the Service for you (store, process, back up, and display your
        data). Our handling of personal data is described in the
        <a href="/legal/privacy" class="link">Privacy Policy</a>.
      </p>
    </section>

    <section>
      <h2 class="font-serif text-lg text-fg">6. Fees</h2>
      <p class="mt-2">
        [If you charge for the Service, describe pricing, billing cycle, taxes, and refunds here.
        Otherwise state that the Service is provided free of charge.] Payments to your customers are
        processed by third parties (e.g. Stripe) under their own terms.
      </p>
    </section>

    <section>
      <h2 class="font-serif text-lg text-fg">7. Disclaimers</h2>
      <p class="mt-2">
        The Service is not a substitute for professional accounting, tax, or legal advice. Any
        tax-related figures or reminders are informational estimates only. You are responsible for
        the accuracy of your records and for your own filings.
      </p>
    </section>

    <section>
      <h2 class="font-serif text-lg text-fg">8. Limitation of liability</h2>
      <p class="mt-2">
        To the maximum extent permitted by law, we are not liable for indirect, incidental, or
        consequential damages, or for lost profits or data. [Add any liability cap and carve-outs
        appropriate to your jurisdiction.]
      </p>
    </section>

    <section>
      <h2 class="font-serif text-lg text-fg">9. Termination</h2>
      <p class="mt-2">
        You may stop using the Service at any time. We may suspend or terminate access for breach of
        these Terms or where required by law. You can export your data before closing your account.
      </p>
    </section>

    <section>
      <h2 class="font-serif text-lg text-fg">10. Changes</h2>
      <p class="mt-2">
        We may update these Terms. Material changes will be posted here with a new "last updated"
        date; continued use after a change means you accept the revised Terms.
      </p>
    </section>

    <section>
      <h2 class="font-serif text-lg text-fg">11. Contact</h2>
      <p class="mt-2">
        Questions about these Terms: <strong>[contact@example.com]</strong>. Governing law:
        <strong>[jurisdiction]</strong>.
      </p>
    </section>

    <p class="border-t border-fg/10 pt-6 text-xs text-fg/50">
      These Terms cover the service the operator provides to you. The underlying Thalermark software
      is separately licensed to the operator under the AGPL.
    </p>
  </div>

  <div class="mt-10">
    <a href="/sign-up" class="link text-sm">← Back to sign-up</a>
  </div>
</div>

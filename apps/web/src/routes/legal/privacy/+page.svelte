<script lang="ts">
  // TEMPLATE Privacy Policy shipped with the self-host bundle so the sign-up
  // legal-consent clickwrap (PUBLIC_PRIVACY_URL) has something to link to out of
  // the box. Generic boilerplate — NOT legal advice. Every deploy that opens
  // sign-up to real users must review + customize this with counsel, or point
  // PUBLIC_PRIVACY_URL at its own hosted page. Bracketed [placeholders] and the
  // third-party list mark what an operator fills in for their own stack.
</script>

<svelte:head>
  <title>Privacy Policy</title>
  <meta name="robots" content="noindex" />
</svelte:head>

<div class="mx-auto max-w-3xl px-6 py-12 sm:py-20">
  <div class="mb-10 rounded border border-accent/40 bg-accent/[0.06] p-4 text-sm text-fg/80">
    <p class="font-semibold text-fg">Template — customize before launch.</p>
    <p class="mt-1">
      This is placeholder boilerplate that ships with the self-hosted app, not legal advice. Review
      it with your own counsel and replace the bracketed placeholders before opening sign-up to real
      users, or point <code class="font-mono text-xs">PUBLIC_PRIVACY_URL</code> at your own page.
    </p>
  </div>

  <h1 class="font-serif text-3xl font-light tracking-tight text-fg">Privacy Policy</h1>
  <p class="mt-2 font-mono text-xs uppercase tracking-widest text-fg/50">
    Last updated: [DATE]
  </p>

  <div class="mt-10 space-y-8 text-sm leading-relaxed text-fg/80">
    <section>
      <h2 class="font-serif text-lg text-fg">1. Who we are</h2>
      <p class="mt-2">
        This Service is operated by <strong>[Operator legal name]</strong> at
        <strong>[your domain]</strong>. This policy explains what personal data we collect and how
        we use it. For data-protection questions, contact <strong>[privacy@example.com]</strong>.
      </p>
    </section>

    <section>
      <h2 class="font-serif text-lg text-fg">2. What we collect</h2>
      <ul class="mt-2 list-disc space-y-1 pl-5">
        <li><strong>Account data</strong> — name, email, and password (stored hashed).</li>
        <li>
          <strong>Business data you enter</strong> — companies, contacts, invoices, estimates,
          expenses, and uploaded receipts.
        </li>
        <li>
          <strong>Technical data</strong> — IP address, user agent, and audit-log entries recording
          actions taken in your account.
        </li>
      </ul>
    </section>

    <section>
      <h2 class="font-serif text-lg text-fg">3. How we use it</h2>
      <p class="mt-2">
        To provide the Service, secure and support your account, keep the audit trail your records
        depend on, and comply with legal obligations. We do not sell your personal data.
      </p>
    </section>

    <section>
      <h2 class="font-serif text-lg text-fg">4. Third parties</h2>
      <p class="mt-2">
        We share data only with the processors needed to run the Service. Update this list to match
        your deployment:
      </p>
      <ul class="mt-2 list-disc space-y-1 pl-5">
        <li><strong>Payments</strong> — [Stripe] processes invoice payments.</li>
        <li><strong>Email</strong> — [Resend / your SMTP provider] delivers transactional email.</li>
        <li>
          <strong>AI features</strong> — if enabled, receipt/insight data is sent to
          [your configured AI provider] for processing. [State whether this is a self-hosted model
          or a third party.]
        </li>
        <li><strong>Hosting</strong> — [your hosting provider] stores the data at rest.</li>
      </ul>
    </section>

    <section>
      <h2 class="font-serif text-lg text-fg">5. Retention</h2>
      <p class="mt-2">
        We keep your data for as long as your account is active and as needed to provide the Service
        and meet legal/record-keeping obligations. You can export your data and request deletion
        (see below).
      </p>
    </section>

    <section>
      <h2 class="font-serif text-lg text-fg">6. Your rights</h2>
      <p class="mt-2">
        Depending on your location, you may have rights to access, correct, export, or delete your
        personal data, and to object to or restrict certain processing. To exercise them, contact
        <strong>[privacy@example.com]</strong>. [Add GDPR/CCPA-specific language as applicable.]
      </p>
    </section>

    <section>
      <h2 class="font-serif text-lg text-fg">7. Security</h2>
      <p class="mt-2">
        We use reasonable technical and organizational measures to protect your data, including
        tenant isolation, encryption in transit, and access controls. No system is perfectly secure.
      </p>
    </section>

    <section>
      <h2 class="font-serif text-lg text-fg">8. Cookies</h2>
      <p class="mt-2">
        We use strictly necessary cookies to keep you signed in and remember your active workspace.
        [Describe any analytics or optional cookies you add.]
      </p>
    </section>

    <section>
      <h2 class="font-serif text-lg text-fg">9. Children</h2>
      <p class="mt-2">
        The Service is not directed to children under 16 and we do not knowingly collect their data.
      </p>
    </section>

    <section>
      <h2 class="font-serif text-lg text-fg">10. Changes</h2>
      <p class="mt-2">
        We may update this policy. Material changes will be posted here with a new "last updated"
        date.
      </p>
    </section>
  </div>

  <div class="mt-10">
    <a href="/sign-up" class="link text-sm">← Back to sign-up</a>
  </div>
</div>

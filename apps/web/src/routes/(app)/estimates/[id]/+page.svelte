<script lang="ts">
  import AuditHistory from '$lib/components/AuditHistory.svelte';
  import ConfirmSubmit from '$lib/components/ConfirmSubmit.svelte';
  import SplitButton from '$lib/components/SplitButton.svelte';
  import SubmitButton from '$lib/components/SubmitButton.svelte';
  import { may } from '$lib/perms';
  import { formatUnitPrice } from '@thalermark/validation';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const est = $derived(data.estimate);
  const contact = $derived(data.contact);

  // Role gate (UX only — the API is authoritative). Every estimate write and
  // state action is `sales:write`; each status gate below is ANDed with it so a
  // viewer/accountant sees no action buttons.
  const canWrite = $derived(may(data.role, 'sales:write'));

  // Mirrors the API state machine. mark-sent only fires from draft;
  // mark-accepted / mark-declined fire from draft or sent (the operator
  // can capture a verbal close without going through send). Accepted +
  // declined are terminal, so their buttons disappear.
  // Send covers both first-send (draft → sent + email) and resend (sent →
  // email only) — API handles the dispatch. /mark-sent stays for the
  // delivered-out-of-band path so a paper handoff still flips status
  // without firing an email.
  const canSend = $derived(canWrite && (est.status === 'draft' || est.status === 'sent'));
  const canMarkSent = $derived(canWrite && est.status === 'draft');
  const canMarkAccepted = $derived(canWrite && (est.status === 'draft' || est.status === 'sent'));
  const canMarkDeclined = $derived(canWrite && (est.status === 'draft' || est.status === 'sent'));
  const canEdit = $derived(canWrite && est.status === 'draft');
  // Convert is the "estimate → invoice" link action (slice 8.7d). Gated to
  // accepted estimates with no existing converted invoice; once converted,
  // the button is replaced with a link to the new invoice further down.
  const canConvert = $derived(
    canWrite && est.status === 'accepted' && est.convertedInvoiceId == null,
  );
  // Pulled back to be corrected and not yet resent (TMC-227) — derived, not a
  // stored status, exactly like isExpired below.
  const isRevising = $derived(est.status === 'draft' && est.sentAt !== null);
  // A string, not an inline {#if}: Svelte trims block-edge whitespace and ran
  // the date into the preceding word ("pulled this backon 2026-08-11").
  const pulledBackOn = $derived(
    est.revisions?.[0]?.revisedAt ? ` on ${est.revisions[0].revisedAt.slice(0, 10)}` : '',
  );
  const statusLabel = $derived(isRevising ? 'being revised' : est.status);
  // Never converted: the invoice is the document that is wrong by then, and
  // the API refuses with already_converted.
  const canRevise = $derived(
    canWrite && est.status === 'sent' && est.convertedInvoiceId == null,
  );
  const hasActions = $derived(
    canSend || canMarkSent || canRevise || canMarkAccepted || canMarkDeclined || canConvert,
  );

  let showOverride = $state(false);
  const sendLabel = $derived(
    isRevising
      ? 'Resend corrected estimate'
      : est.status === 'sent'
        ? 'Resend estimate'
        : 'Send estimate',
  );

  // Advisory expiry: status doesn't flip to 'expired' in MVP (no background
  // sweep yet). Read sites compute the warning off expires_on < today, but
  // only on sent estimates — drafts haven't gone out, accepted/declined are
  // closed records, and an expires_on in the past on those carries no
  // operational signal.
  const todayIso = new Date().toISOString().slice(0, 10);
  const isExpired = $derived(
    est.status === 'sent' && est.expiresOn != null && est.expiresOn < todayIso,
  );

  // Share URL surfaces once mark-sent mints the token. Same pattern as the
  // invoice detail page — absolute URL built off origin so it works behind
  // any proxy. The unauthed /e/[token] public page lands in slice 8.7e;
  // until then the URL still works for any internal preview tooling.
  const publicUrl = $derived(est.publicToken ? `${data.origin}/e/${est.publicToken}` : null);
</script>

<a href="/estimates" class="eyebrow text-fg/60 hover:text-fg">← Estimates</a>
<div class="mt-3 flex items-baseline justify-between gap-6">
  <h1 class="font-serif text-4xl font-light leading-none tracking-tight text-fg">
    Estimate {est.number}<span class="text-accent">.</span>
  </h1>
  <div class="flex items-center gap-3">
    {#if canEdit}
      <a
        href="/estimates/{est.id}/edit"
        class="rounded-sm border border-fg/20 px-3 py-1 font-mono text-xs uppercase tracking-widest text-fg/70 hover:border-accent hover:text-accent"
      >
        Edit
      </a>
    {/if}
    <!-- Duplicate-as-template: any status. Posts to ?/duplicate → new draft's edit page. -->
    {#if canWrite}
      <form method="post" action="?/duplicate">
        <SubmitButton
          label="Duplicate"
          pendingLabel="Duplicating…"
          class="rounded-sm border border-fg/20 px-3 py-1 font-mono text-xs uppercase tracking-widest text-fg/70 hover:border-accent hover:text-accent"
        />
      </form>
    {/if}
    <span class="font-mono text-xs uppercase tracking-widest text-fg/60">{statusLabel}</span>
  </div>
</div>

{#if form?.transitionError}
  <div class="mt-6 rounded-sm border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger" data-form-error role="alert" tabindex="-1">
    {form.transitionError}
  </div>
{/if}

{#if data.sentTo && data.sendUndelivered}
  <div class="mt-6 rounded-sm border border-warning/40 bg-warning/5 px-4 py-3 text-sm text-fg">
    Marked as sent — but <span class="font-medium">no email was delivered</span>. This server has no
    email set up, so nothing reached {data.sentTo}. The estimate is saved and its share link works;
    send the customer that link yourself, or
    <a class="link" href="/settings/email">set up email</a>.
  </div>
{:else if data.sentTo}
  <div class="mt-6 rounded-sm border border-accent/30 bg-accent/5 px-4 py-3 text-sm text-fg">
    Sent to <span class="font-medium">{data.sentTo}</span>.
  </div>
{/if}

{#if isExpired}
  <div class="mt-6 rounded-sm border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
    This estimate's validity expired on <span class="font-medium">{est.expiresOn}</span>.
  </div>
{/if}

{#if isRevising}
  <!-- The stranded-draft nudge (TMC-227). Correcting is three actions and the
       middle one ends on the edit page, so it is easy to stop after two —
       leaving a customer holding a quote they cannot accept. -->
  <div class="mt-6 rounded-sm border border-warning/40 bg-warning/5 px-4 py-3 text-sm text-fg">
    You pulled this back{pulledBackOn} — the customer's link says it's being revised, and they
    can't accept it, until you resend the corrected estimate.
  </div>
{/if}

{#if hasActions}
  <div class="mt-6 flex flex-wrap items-center gap-3">
    {#if canSend}
      <form method="post" action="?/send" class="flex flex-wrap items-center gap-2">
        {#if showOverride}
          <input
            type="email"
            name="to"
            placeholder={contact?.email ?? 'recipient@example.com'}
            class="rounded-sm border border-fg/20 bg-surface-2 px-3 py-2 text-sm text-fg placeholder:text-fg/40 focus:border-accent focus:outline-none"
          />
        {/if}
        <SplitButton
          label="Send options"
          caretClass="border-l border-surface/20 bg-inverse text-on-inverse hover:bg-accent"
        >
          {#snippet primary()}
            <SubmitButton
              label={sendLabel}
              pendingLabel="Sending…"
              class="rounded-l-sm bg-inverse px-4 py-2 text-sm font-medium text-on-inverse transition-colors hover:bg-accent"
            />
          {/snippet}
          {#snippet menu(close)}
            <button
              type="button"
              role="menuitem"
              onclick={() => {
                showOverride = true;
                close();
              }}
              class="block w-full px-4 py-2 text-left text-sm text-fg/80 transition-colors hover:bg-surface-2 hover:text-fg"
            >
              Send to a different email…
            </button>
            {#if canMarkSent}
              <!-- Retargets the enclosing send form to ?/markSent via formaction
                   (no nested <form>). Like the Mark paid menu, the POST navigation
                   dismisses the menu itself, so we must NOT call close() or the
                   form detaches before submit. formnovalidate skips the optional
                   `to` email field's constraint check. -->
              <SubmitButton
                formaction="?/markSent"
                formnovalidate
                role="menuitem"
                class="block w-full border-t border-fg/10 px-4 py-2 text-left text-sm text-fg/80 transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-60"
                label="Mark sent without email"
                pendingLabel="Marking sent…"
              />
            {/if}
          {/snippet}
        </SplitButton>
      </form>
    {/if}
    {#if canMarkAccepted}
      <form method="post" action="?/markAccepted">
        <SubmitButton
          label="Mark accepted"
          pendingLabel="Marking accepted…"
          class="btn-ghost bg-surface-2"
        />
      </form>
    {/if}
    {#if canRevise}
      <!-- Corrective rather than destructive, so the quiet outline. What is
           being confirmed is that the CUSTOMER sees the withdrawal, not that
           anything is lost. -->
      <ConfirmSubmit
        action="?/revise"
        label="Fix this estimate"
        pendingLabel="Pulling back…"
        title="Fix this estimate?"
        confirmLabel="Pull it back"
        triggerClass="rounded-sm border border-fg/20 px-4 py-2 text-sm font-medium text-fg transition-colors hover:border-accent hover:text-accent"
      >
        {#snippet body()}
          It goes back to a draft you can edit. The customer's link will say it's being revised and
          they won't be able to accept it until you resend it.
        {/snippet}
      </ConfirmSubmit>
    {/if}
    {#if canMarkDeclined}
      <!-- `declined` is terminal in MVP: nothing transitions out of it, edit
           returns not_editable, send returns invalid_transition, and convert
           only runs from `accepted`. Duplicate is the only way back, and it
           works from any status — so the dialog names it. -->
      <ConfirmSubmit
        action="?/markDeclined"
        label="Mark declined"
        pendingLabel="Marking declined…"
        title="Mark this estimate declined?"
        confirmLabel="Mark declined"
        triggerClass="rounded-sm border border-danger/30 px-4 py-2 text-sm font-medium text-danger transition-colors hover:bg-danger/5"
      >
        {#snippet body()}
          It closes the estimate out — you can't undo it, edit it, send it again, or turn it into an
          invoice.
          {#if est.status === 'sent'}
            The Accept button on the customer's copy stops working too.
          {/if}
          If they come back, duplicate it into a fresh estimate.
        {/snippet}
      </ConfirmSubmit>
    {/if}
    {#if canConvert}
      <form method="post" action="?/convert">
        <SubmitButton label="Convert to invoice" pendingLabel="Converting…" class="btn" />
      </form>
    {/if}
  </div>
{/if}

{#if est.convertedInvoiceId}
  <div class="mt-6 rounded-sm border border-accent/40 bg-accent/5 px-4 py-3 text-sm text-fg">
    Converted to
    <a href="/invoices/{est.convertedInvoiceId}" class="font-medium text-accent hover:underline">
      invoice →
    </a>
  </div>
{/if}

{#if publicUrl}
  <div class="mt-6 rounded-sm border border-fg/10 bg-surface-2 p-4">
    <p class="label">Share link</p>
    <div class="mt-2 flex flex-wrap items-center gap-3 text-sm">
      <a href={publicUrl} target="_blank" rel="noopener" class="break-all text-accent hover:underline">
        {publicUrl}
      </a>
    </div>
    <p class="mt-2 text-xs text-fg/50">
      Anyone with this link can view the estimate.
    </p>
  </div>
{/if}

<dl class="mt-8 grid grid-cols-1 gap-x-12 gap-y-6 sm:grid-cols-3">
  <div>
    <dt class="label">Contact</dt>
    <dd class="mt-1 text-fg">
      {#if contact}
        <a href="/contacts/{contact.id}" class="hover:text-accent">{contact.name}</a>
      {:else}
        —
      {/if}
    </dd>
  </div>
  <div>
    <dt class="label">Issued</dt>
    <dd class="mt-1 text-fg">{est.issueDate}</dd>
  </div>
  <div>
    <dt class="label">Expires</dt>
    <dd class="mt-1 text-fg">{est.expiresOn ?? '—'}</dd>
  </div>
</dl>

<div class="mt-10 overflow-hidden rounded-sm border border-fg/10 bg-surface-2">
  <table class="w-full text-left text-sm">
    <thead class="bg-surface">
      <tr class="label">
        <th class="px-5 py-3">Description</th>
        <th class="px-5 py-3 text-right">Qty</th>
        <th class="px-5 py-3 text-right">Unit price</th>
        <th class="px-5 py-3 text-right">Amount</th>
      </tr>
    </thead>
    <tbody class="divide-y divide-fg/10">
      {#each est.lineItems as li (li.id)}
        <tr>
          <td class="px-5 py-4 text-fg">
            {li.description}
            {#if li.taxable}
              <span class="block text-xs text-fg/40">Taxable · {Number(li.taxRatePct)}%</span>
            {/if}
          </td>
          <td class="px-5 py-4 text-right font-mono tabular-nums text-fg/80"
            >{li.quantity}{#if li.unitLabel}&nbsp;{li.unitLabel}{/if}</td
          >
          <td class="px-5 py-4 text-right font-mono tabular-nums text-fg/80">{formatUnitPrice(li.unitPrice)}</td>
          <td class="px-5 py-4 text-right font-mono tabular-nums text-fg">{li.amount}</td>
        </tr>
      {/each}
    </tbody>
    <tfoot class="bg-surface">
      <tr>
        <td colspan="3" class="px-5 py-3 text-right label">
          Subtotal
        </td>
        <td class="px-5 py-3 text-right font-mono tabular-nums text-fg">{est.subtotal}</td>
      </tr>
      <tr>
        <td colspan="3" class="px-5 py-3 text-right label">
          Tax
        </td>
        <td class="px-5 py-3 text-right font-mono tabular-nums text-fg">{est.tax}</td>
      </tr>
      <tr>
        <td colspan="3" class="px-5 py-3 text-right label">
          Total ({est.currency})
        </td>
        <td class="px-5 py-3 text-right font-mono tabular-nums text-lg text-fg">{est.total}</td>
      </tr>
    </tfoot>
  </table>
</div>

{#if est.notes}
  <div class="mt-8">
    <h2 class="label">Notes</h2>
    <p class="mt-2 whitespace-pre-wrap text-fg/80">{est.notes}</p>
  </div>
{/if}

<AuditHistory events={data.auditEvents} />

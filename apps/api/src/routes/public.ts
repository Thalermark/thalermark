import {
  type Database,
  SYSTEM_USER_ID,
  auditEvents,
  companies,
  contacts,
  estimateLineItems,
  estimateRevisions,
  estimates,
  invoiceLineItems,
  invoicePayments,
  invoiceRevisions,
  invoices,
} from '@thalermark/db';
import { getLogger } from '@thalermark/logger';
import { centsToMoney, localDay } from '@thalermark/validation';
import { and, asc, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { v7 as uuidv7 } from 'uuid';
import type { AppDeps } from '../app.js';
import { applyProviderEvent } from '../lib/delivery.js';
import {
  checkPaymentEligibility,
  paidCentsForInvoice,
  paymentCountForInvoice,
  summarizeSettlement,
  syncInvoiceSettlement,
} from '../lib/invoice-payments.js';
import { postInvoicePayment } from '../lib/ledger.js';
import type { Mailer } from '../lib/mailer.js';
import { estimateAcceptedNotice, invoicePaidNotice, notifyOwner } from '../lib/owner-notify.js';
import { mapResendEvent, verifyResendSignature } from '../lib/resend-webhook.js';
import { UUID_RE } from '../lib/route-helpers.js';
import { reindexEntities } from '../lib/search/reindex.js';
import { accountFacts, connectState } from '../lib/stripe-connect.js';
import {
  constructWebhookEvent,
  decimalDollarsToCents,
  paymentIntentFeeCents,
} from '../lib/stripe.js';
import { RATE_LIMITS, rateLimit } from '../middleware/rate-limit.js';
import type { RlsVariables } from '../middleware/rls-context.js';

const log = getLogger(['api', 'public']);

// public — the unauthenticated public surface + the Stripe webhook. The public
// invoice / estimate views (the pay link + the accept/decline page), the
// PaymentIntent create for the branded /pay route, and the Stripe webhook
// (checkout/PaymentIntent success → mark invoice paid + post the ledger;
// account.updated → sync Connect onboarding flags). A deps-taking sub-app
// (deps.stripe for the webhook + PaymentIntent, deps.storage for the public
// view's signed logo URL). Every route runs on the BOOTSTRAP db
// (deps.bootstrapDb ?? deps.db): rls-context skips /api/public/* and
// /api/webhooks/*, so there's no tenant tx — the public token IS the
// authorization, and the webhook is attributed to the SYSTEM_USER_ID seeded by
// migration 0009. MOUNT-ONLY: no typed hc consumer (web fetches these by URL
// from its unauthenticated pay/view pages; Stripe calls the webhook directly),
// so there's no PublicAppType in api-contract and no client facade override —
// the same shape as the files sub-app.

// Public accept/decline handler. Lives outside createApp so the two POST
// routes share a single implementation and the audit row + state machine
// stay symmetric. Bootstrap-db path: rls-context skips /api/public/*, so
// there's no tenant tx and no c.var.audit — we insert the row directly,
// attributed to the SYSTEM_USER_ID seeded by migration 0009. Status guard
// is sent-only: any other state (draft / accepted / declined / expired)
// returns 409 so a stale page POSTing twice can't accidentally flip a
// closed estimate.
async function publicEstimateRespond(
  c: Context,
  bootstrapDb: Database,
  decision: 'accept' | 'decline',
  mail?: { mailer?: Mailer; emailFrom?: string },
) {
  const token = c.req.param('token');
  if (!token) return c.json({ error: 'estimate_not_found' }, 404);
  const [current] = await bootstrapDb
    .select()
    .from(estimates)
    .where(eq(estimates.publicToken, token))
    .limit(1);
  if (!current) return c.json({ error: 'estimate_not_found' }, 404);
  if (current.status !== 'sent') {
    return c.json({ error: 'invalid_transition', from: current.status, to: decision }, 409);
  }

  const now = new Date();
  const targetStatus = decision === 'accept' ? 'accepted' : 'declined';
  const stampPatch = decision === 'accept' ? { acceptedAt: now } : { declinedAt: now };
  const [updated] = await bootstrapDb
    .update(estimates)
    .set({ status: targetStatus, updatedAt: now, ...stampPatch })
    .where(eq(estimates.id, current.id))
    .returning();
  if (!updated) return c.json({ error: 'estimate_not_found' }, 404);

  await bootstrapDb.insert(auditEvents).values({
    id: uuidv7(),
    accountId: current.accountId,
    companyId: current.companyId,
    actorUserId: SYSTEM_USER_ID,
    entityType: 'estimate',
    entityId: current.id,
    action: `public-${decision}`,
    before: {
      status: current.status,
      acceptedAt: current.acceptedAt,
      declinedAt: current.declinedAt,
    },
    after: {
      status: updated.status,
      acceptedAt: updated.acceptedAt,
      declinedAt: updated.declinedAt,
    },
  });

  // The public paths skip rlsContext entirely, so there is no tenant tx and no
  // c.var.audit — which means the audit-driven search reindex never fires here
  // (TMC-198). Without this line, a customer accepting an estimate would leave
  // it showing as "sent" in search forever. Handing the projector bootstrapDb
  // is safe because every projector filters account_id explicitly rather than
  // relying on the policy.
  await reindexEntities(bootstrapDb, current.accountId, [
    { entityType: 'estimate', entityId: current.id },
  ]);

  // Tell the owner (TMC-230). Acceptance is the highest-value event in the
  // product and it used to notify nobody — while simultaneously dropping the
  // estimate out of the dashboard tile that tracks 'sent'. A decline is
  // deliberately quiet: it needs no action, and a mail saying "you lost that
  // one" the moment it happens is not a kindness.
  if (decision === 'accept') {
    const [customer] = await bootstrapDb
      .select({ name: contacts.name })
      .from(contacts)
      .where(eq(contacts.id, current.contactId))
      .limit(1);
    await notifyOwner(bootstrapDb, {
      accountId: current.accountId,
      mailer: mail?.mailer,
      emailFrom: mail?.emailFrom,
      notice: estimateAcceptedNotice({
        customerName: customer?.name ?? 'A customer',
        number: current.number,
        total: current.total,
        currency: current.currency,
      }),
    });
  }

  return c.json({
    status: updated.status,
    acceptedAt: updated.acceptedAt,
    declinedAt: updated.declinedAt,
  });
}

export function publicRoutes(deps: AppDeps) {
  const bootstrapDb = deps.bootstrapDb ?? deps.db;
  return (
    new Hono<{ Variables: RlsVariables }>()
      .get('/api/public/invoices/:token', async (c) => {
        const token = c.req.param('token');
        const [invoice] = await bootstrapDb
          .select()
          .from(invoices)
          .where(eq(invoices.publicToken, token))
          .limit(1);
        if (!invoice) return c.json({ error: 'invoice_not_found' }, 404);

        // First open only (TMC-230). "Did they even see it?" is the question an
        // unpaid invoice raises after a fortnight, and until now nothing
        // recorded the answer. Stamped once so it stays the FIRST view rather
        // than drifting to the most recent refresh, and left as a fire-and-
        // forget write: a customer looking at their bill must never be shown an
        // error because a bookkeeping stamp failed.
        if (!invoice.viewedAt) {
          await bootstrapDb
            .update(invoices)
            .set({ viewedAt: new Date() })
            .where(eq(invoices.id, invoice.id))
            .catch(() => {});
        }

        const [company] = await bootstrapDb
          .select({
            name: companies.name,
            businessAddress: companies.businessAddress,
            businessPhone: companies.businessPhone,
            businessEmail: companies.businessEmail,
            logoStorageKey: companies.logoStorageKey,
            stripeConnectAccountId: companies.stripeConnectAccountId,
            stripeConnectChargesEnabled: companies.stripeConnectChargesEnabled,
            paymentCashEnabled: companies.paymentCashEnabled,
            paymentCheckEnabled: companies.paymentCheckEnabled,
            paymentCheckPayableTo: companies.paymentCheckPayableTo,
            paymentCheckAddress: companies.paymentCheckAddress,
            paymentVenmoHandle: companies.paymentVenmoHandle,
            paymentZelleContact: companies.paymentZelleContact,
          })
          .from(companies)
          .where(eq(companies.id, invoice.companyId))
          .limit(1);
        const [customer] = await bootstrapDb
          .select({ name: contacts.name })
          .from(contacts)
          .where(eq(contacts.id, invoice.contactId))
          .limit(1);
        const lines = await bootstrapDb
          .select({
            id: invoiceLineItems.id,
            position: invoiceLineItems.position,
            description: invoiceLineItems.description,
            quantity: invoiceLineItems.quantity,
            unitPrice: invoiceLineItems.unitPrice,
            amount: invoiceLineItems.amount,
            unitLabel: invoiceLineItems.unitLabel,
            taxable: invoiceLineItems.taxable,
            taxRatePct: invoiceLineItems.taxRatePct,
            taxAmount: invoiceLineItems.taxAmount,
          })
          .from(invoiceLineItems)
          .where(eq(invoiceLineItems.invoiceId, invoice.id))
          .orderBy(asc(invoiceLineItems.position));

        // Connect routing lives in lib/stripe-connect.ts because the owner's
        // own invoice page asks the same question and the two answers must
        // agree — see the note there.
        //
        // connectPending is NOT rendered to the recipient as "this business
        // hasn't set up payments". A customer should never be shown their
        // supplier's unfinished admin; it reads as an outfit that can't get its
        // house in order, and it is not the recipient's problem to solve. The
        // owner gets told instead. All the public page does with it is fall
        // back to a neutral "contact them to arrange payment" line, and only
        // when there is no offline method to offer either.
        const { connectReady } = connectState({
          requireConnectedAccount: deps.requireConnectedAccount === true,
          stripeConfigured: deps.stripe != null,
          connectAccountId: company?.stripeConnectAccountId ?? null,
          chargesEnabled: company?.stripeConnectChargesEnabled === true,
        });

        // Offline "pay me directly" instructions — only the enabled methods,
        // with their display values, so the public page renders nothing it
        // shouldn't. Check defaults its payable-to name to the company name.
        // These are display-only; the business confirms receipt via mark-paid.
        // Logo for the public sender block. A fresh signed URL is minted per
        // page load so it never serves a stale/expired link. Best-effort: if
        // storage is unconfigured or signing fails, the page falls back to the
        // text-only sender block. NB self-host s3 needs a publicly reachable
        // S3_ENDPOINT for the recipient's browser; the local-FS adapter serves
        // through the same-origin /api/files token route, so it just works.
        let companyLogoUrl: string | null = null;
        if (company?.logoStorageKey && deps.storage) {
          companyLogoUrl = await deps.storage
            .getSignedDownloadUrl(company.logoStorageKey, { expiresInSeconds: 3600 })
            .catch(() => null);
        }

        const offlinePayment = {
          cash: company?.paymentCashEnabled ?? false,
          check: company?.paymentCheckEnabled
            ? {
                payableTo: company.paymentCheckPayableTo ?? company.name ?? null,
                address: company.paymentCheckAddress ?? null,
              }
            : null,
          venmo: company?.paymentVenmoHandle || null,
          zelle: company?.paymentZelleContact || null,
        };

        // What is actually still owed. The PaymentIntent below has charged
        // total − paid since TMC-187, but this payload only ever carried the
        // total, so the recipient's page had no number to render but the wrong
        // one — a customer who paid a deposit saw the full amount back with no
        // acknowledgement their money landed (TMC-210). Derived here from the
        // payment rows through the same helper the write paths use, so the
        // public view cannot drift from the books.
        const paidCents = await paidCentsForInvoice(bootstrapDb, {
          accountId: invoice.accountId,
          invoiceId: invoice.id,
        });
        const settlement = summarizeSettlement({
          totalCents: decimalDollarsToCents(invoice.total),
          paidCents,
          issued: invoice.sentAt !== null,
        });

        // The correction history, shown to the RECIPIENT (TMC-227). This is the
        // differentiator: QuickBooks edits a sent invoice silently and keeps its
        // audit log private, so the customer's only clue is that the number
        // moved. Thalermark says "Revised Aug 11, 2026 — the total was $450.00"
        // on the page they were going to pay from.
        //
        // account_id is filtered explicitly as well as invoice_id. Public routes
        // skip rlsContext and read through bootstrapDb, so there is no tenant
        // context here and this is the only thing scoping the read — the same
        // defence-in-depth every authenticated SELECT applies.
        const revisions = await bootstrapDb
          .select({
            revisedAt: invoiceRevisions.revisedAt,
            previousTotal: invoiceRevisions.previousTotal,
          })
          .from(invoiceRevisions)
          .where(
            and(
              eq(invoiceRevisions.accountId, invoice.accountId),
              eq(invoiceRevisions.invoiceId, invoice.id),
            ),
          )
          .orderBy(desc(invoiceRevisions.revisedAt));

        return c.json({
          number: invoice.number,
          status: invoice.status,
          // Mid-correction: the business has pulled this back and has not
          // resent it yet. Every payment path is already closed by the 'sent'
          // gates below, so this exists to tell the recipient WHY the page went
          // quiet rather than leaving them at a document that stopped working.
          beingRevised: invoice.status === 'draft' && invoice.sentAt !== null,
          revisions,
          issueDate: invoice.issueDate,
          dueDate: invoice.dueDate,
          currency: invoice.currency,
          subtotal: invoice.subtotal,
          tax: invoice.tax,
          total: invoice.total,
          // Decimal strings, like every money value crossing the API. `paid` is
          // signed, so a refund nets itself out; `outstanding` is what the Pay
          // button charges.
          paid: settlement.paid,
          outstanding: settlement.outstanding,
          settlement: settlement.settlement,
          notes: invoice.notes,
          sentAt: invoice.sentAt,
          paidAt: invoice.paidAt,
          companyName: company?.name ?? null,
          // From-block contact fields are gated per-invoice: a false show flag
          // means the value never reaches the recipient's page (not merely
          // hidden client-side). The company name + logo always show.
          companyAddress: invoice.showAddress ? (company?.businessAddress ?? null) : null,
          companyPhone: invoice.showPhone ? (company?.businessPhone ?? null) : null,
          companyEmail: invoice.showEmail ? (company?.businessEmail ?? null) : null,
          companyLogoUrl,
          customerName: customer?.name ?? null,
          lineItems: lines,
          // Tell the client whether the Pay button is wirable. Avoids a
          // separate config probe; the recipient's page can branch on this
          // alone without inferring from a 503 on the session-mint call.
          payable: deps.stripe != null && invoice.status === 'sent' && connectReady,
          // Deliberately NOT connectPending. The recipient is told what they
          // can do, never why the business can't do it — the reason is the
          // owner's to see and fix. This says only "there is no way to pay from
          // this page", which is the one fact the recipient needs in order to
          // go and ask. False whenever a card or any offline method is offered.
          noPaymentMethod:
            invoice.status === 'sent' &&
            !(deps.stripe != null && connectReady) &&
            !offlinePayment.cash &&
            !offlinePayment.check &&
            !offlinePayment.venmo &&
            !offlinePayment.zelle,
          // Offline methods show whenever the invoice is still open, regardless
          // of Stripe — they're how an un-Connected business gets paid at all.
          offlinePayment: invoice.status === 'sent' ? offlinePayment : null,
        });
      })
      // Stripe PaymentIntent mint for the branded /pay page's Payment Element.
      // Lazy — the SvelteKit /pay loader POSTs here only once the recipient has
      // clicked through to that route, so we don't bill a Stripe API call on
      // every passive invoice view. Status guard mirrors the public-invoice
      // GET's `payable` flag; the duplicate check is deliberate (the client
      // could be stale or hand-crafted). The post-payment return_url lives
      // client-side in confirmPayment, so this route no longer needs publicAppUrl.
      .post(
        '/api/public/invoices/:token/payment-intent',
        rateLimit(deps, RATE_LIMITS.publicPay, (c) => c.req.param('token')),
        async (c) => {
          if (!deps.stripe) return c.json({ error: 'stripe_not_configured' }, 503);
          const token = c.req.param('token');
          const [invoice] = await bootstrapDb
            .select()
            .from(invoices)
            .where(eq(invoices.publicToken, token))
            .limit(1);
          if (!invoice) return c.json({ error: 'invoice_not_found' }, 404);
          if (invoice.status !== 'sent') {
            return c.json({ error: 'not_payable', status: invoice.status }, 409);
          }
          // Charge the OUTSTANDING balance, not the invoice total (TMC-187).
          // Once a deposit can be recorded, minting for the total would bill the
          // customer a second time for money the business already has — the
          // exact bug partial payments would otherwise introduce on day one.
          // With no payments recorded this is the total, so the common path is
          // unchanged.
          const paidCents = await paidCentsForInvoice(bootstrapDb, {
            accountId: invoice.accountId,
            invoiceId: invoice.id,
          });
          const amountCents = decimalDollarsToCents(invoice.total) - paidCents;
          if (amountCents <= 0) return c.json({ error: 'invalid_amount' }, 400);

          // Connect routing decision. A company that has onboarded Connect must
          // have Stripe-side charges_enabled before we'll mint a session — Stripe
          // will reject it otherwise, and a clean 503 here surfaces the wait
          // state to the recipient instead of a generic Stripe error. Self-host
          // companies (no stripeConnectAccountId) keep the 8.5c platform-account
          // path: stripeAccount is not passed, so Checkout runs on the operator's
          // own STRIPE_SECRET_KEY.
          const [company] = await bootstrapDb
            .select({
              stripeConnectAccountId: companies.stripeConnectAccountId,
              stripeConnectChargesEnabled: companies.stripeConnectChargesEnabled,
            })
            .from(companies)
            .where(eq(companies.id, invoice.companyId))
            .limit(1);
          if (company?.stripeConnectAccountId && !company.stripeConnectChargesEnabled) {
            return c.json({ error: 'connect_not_ready' }, 503);
          }
          // The platform-account fallback, refused (TMC-175). Without a connected
          // account there is nowhere to route this charge that isn't the
          // operator's own balance, so decline rather than take the money into
          // the wrong account. Mirrors the `payable` gate on the GET above; the
          // duplicate check is deliberate, since a stale or hand-crafted client
          // can reach this route without having read that flag.
          if (deps.requireConnectedAccount && !company?.stripeConnectAccountId) {
            log.error('payment-intent refused: company {companyId} has no connected account', {
              companyId: invoice.companyId,
            });
            return c.json({ error: 'connect_required' }, 503);
          }
          const requestOptions = company?.stripeConnectAccountId
            ? { stripeAccount: company.stripeConnectAccountId }
            : undefined;

          const intent = await deps.stripe.client.paymentIntents.create(
            {
              amount: amountCents,
              currency: invoice.currency.toLowerCase(),
              // Lets the Payment Element offer whatever methods the (connected
              // or platform) account has enabled — card, Link, wallets — without
              // us enumerating them here.
              automatic_payment_methods: { enabled: true },
              description: `Invoice ${invoice.number}`,
              // Echoed on the payment_intent.succeeded webhook — the sole lookup
              // for the invoice-id → mark-paid transition. Resolved purely by
              // metadata regardless of which connected account ran the charge.
              metadata: { invoiceId: invoice.id, accountId: invoice.accountId },
            },
            requestOptions,
          );

          return c.json({
            clientSecret: intent.client_secret,
            publishableKey: deps.stripe.publishableKey,
            // The figure the pay page must print. Returned from the same call
            // that created the charge rather than left to the client to
            // re-derive, so the heading, the button and the intent are one
            // number by construction and cannot disagree again (TMC-210).
            amount: centsToMoney(amountCents),
            currency: invoice.currency,
            // Direct charges live on the connected account, so the browser must
            // init stripe.js in that account's context (loadStripe's stripeAccount
            // option) for the Payment Element to resolve this intent. Null on the
            // self-host / platform path, where the intent is on the operator key.
            stripeAccountId: company?.stripeConnectAccountId ?? null,
          });
        },
      )
      // Public estimate view — mirror of the public invoice route, minus
      // payable / Stripe wiring (estimates aren't a debt). Bootstrap reads
      // for the same reason: rls-context skips /api/public/* and no tenant
      // context is set. Returns customer-facing fields only — account /
      // company ids and the audit trail stay out.
      .get('/api/public/estimates/:token', async (c) => {
        const token = c.req.param('token');
        const [estimate] = await bootstrapDb
          .select()
          .from(estimates)
          .where(eq(estimates.publicToken, token))
          .limit(1);
        if (!estimate) return c.json({ error: 'estimate_not_found' }, 404);

        const [company] = await bootstrapDb
          .select({
            name: companies.name,
            businessAddress: companies.businessAddress,
            businessPhone: companies.businessPhone,
            businessEmail: companies.businessEmail,
            logoStorageKey: companies.logoStorageKey,
          })
          .from(companies)
          .where(eq(companies.id, estimate.companyId))
          .limit(1);
        const [customer] = await bootstrapDb
          .select({ name: contacts.name })
          .from(contacts)
          .where(eq(contacts.id, estimate.contactId))
          .limit(1);
        const lines = await bootstrapDb
          .select({
            id: estimateLineItems.id,
            position: estimateLineItems.position,
            description: estimateLineItems.description,
            quantity: estimateLineItems.quantity,
            unitPrice: estimateLineItems.unitPrice,
            amount: estimateLineItems.amount,
            unitLabel: estimateLineItems.unitLabel,
            taxable: estimateLineItems.taxable,
            taxRatePct: estimateLineItems.taxRatePct,
            taxAmount: estimateLineItems.taxAmount,
          })
          .from(estimateLineItems)
          .where(eq(estimateLineItems.estimateId, estimate.id))
          .orderBy(asc(estimateLineItems.position));

        // Fresh signed URL for the sender logo per page load — same best-effort
        // pattern as the public invoice (no toggle: the logo always shows when
        // set). Falls back to the text-only sender block if storage is
        // unconfigured or signing fails.
        let companyLogoUrl: string | null = null;
        if (company?.logoStorageKey && deps.storage) {
          companyLogoUrl = await deps.storage
            .getSignedDownloadUrl(company.logoStorageKey, { expiresInSeconds: 3600 })
            .catch(() => null);
        }

        // The correction history, same contract as the invoice page (TMC-227) —
        // account_id filtered explicitly because there is no tenant context on
        // a public route.
        const revisions = await bootstrapDb
          .select({
            revisedAt: estimateRevisions.revisedAt,
            previousTotal: estimateRevisions.previousTotal,
          })
          .from(estimateRevisions)
          .where(
            and(
              eq(estimateRevisions.accountId, estimate.accountId),
              eq(estimateRevisions.estimateId, estimate.id),
            ),
          )
          .orderBy(desc(estimateRevisions.revisedAt));

        return c.json({
          number: estimate.number,
          status: estimate.status,
          // Pulled back to be corrected and not yet resent. Accept and decline
          // already refuse anything but 'sent', so this only has to explain the
          // silence.
          beingRevised: estimate.status === 'draft' && estimate.sentAt !== null,
          revisions,
          issueDate: estimate.issueDate,
          expiresOn: estimate.expiresOn,
          currency: estimate.currency,
          subtotal: estimate.subtotal,
          tax: estimate.tax,
          total: estimate.total,
          notes: estimate.notes,
          sentAt: estimate.sentAt,
          acceptedAt: estimate.acceptedAt,
          declinedAt: estimate.declinedAt,
          companyName: company?.name ?? null,
          // From-block contact fields, gated per-estimate by the show flags (a
          // false flag means the value never reaches the recipient's page).
          companyAddress: estimate.showAddress ? (company?.businessAddress ?? null) : null,
          companyPhone: estimate.showPhone ? (company?.businessPhone ?? null) : null,
          companyEmail: estimate.showEmail ? (company?.businessEmail ?? null) : null,
          companyLogoUrl,
          customerName: customer?.name ?? null,
          lineItems: lines,
          // Tells the public page whether to render Accept/Decline. Only
          // 'sent' is responsive — the customer hasn't decided yet. Once
          // accepted/declined the buttons hide and the banner shows.
          canRespond: estimate.status === 'sent',
        });
      })
      // Public accept/decline. Unauthed; the random token IS the auth (same
      // posture as the public GET above). Status-guarded to 'sent' so a
      // re-submit lands on the same response shape as the first call (the
      // status banner the page renders after refresh). Audit row is
      // attributed to the synthetic system user — same pattern the Stripe
      // webhook uses for provider-driven mutations — and goes through
      // bootstrapDb because RLS would otherwise hide the audit row from
      // the tenant role without app.current_account_id set.
      .post('/api/public/estimates/:token/accept', async (c) =>
        publicEstimateRespond(c, bootstrapDb, 'accept', deps),
      )
      .post('/api/public/estimates/:token/decline', async (c) =>
        publicEstimateRespond(c, bootstrapDb, 'decline', deps),
      )
      // Stripe webhook. Signature-verified against the raw body — the JSON
      // parse must come from the SDK, not Hono's, so we read text() and
      // hand it straight to constructEventAsync. No tenant context; the
      // signature IS the auth. Acknowledges with 200 for any state that
      // doesn't need action (already-paid, missing invoice, non-completion
      // event) so Stripe stops the retry loop.
      .post('/api/webhooks/stripe', async (c) => {
        if (!deps.stripe) return c.json({ error: 'stripe_not_configured' }, 503);
        const sig = c.req.header('stripe-signature');
        if (!sig) return c.json({ error: 'missing_signature' }, 400);
        const rawBody = await c.req.text();
        let event: import('stripe').Stripe.Event;
        try {
          event = await constructWebhookEvent(deps.stripe, rawBody, sig);
        } catch (err) {
          // Logged rather than swallowed: a delivery signed by an endpoint whose
          // secret we don't hold is indistinguishable from no delivery at all,
          // and that is precisely how a captured payment goes unrecorded — the
          // customer is charged, the invoice sits at 'sent', and nothing in the
          // logs says why (TMC-176).
          log.error(
            'stripe webhook signature verification failed against {count} configured secret(s): {msg}',
            {
              count: deps.stripe.webhookSecrets.length,
              msg: err instanceof Error ? err.message : String(err),
            },
          );
          return c.json({ error: 'invalid_signature' }, 400);
        }

        if (event.type === 'payment_intent.succeeded') {
          const intent = event.data.object;
          // succeeded is terminal for the charge, so no extra status check —
          // the invoice id rides on the metadata we set at mint time. Direct-
          // charge intents fire this on the connected account; Stripe delivers
          // it here with event.account set, and constructEventAsync verified it.
          const invoiceId = intent.metadata?.invoiceId;
          if (!invoiceId || !UUID_RE.test(invoiceId)) {
            return c.json({ received: true });
          }

          const [current] = await bootstrapDb
            .select()
            .from(invoices)
            .where(eq(invoices.id, invoiceId))
            .limit(1);
          if (!current) return c.json({ received: true });
          // Whether a receipt may be recorded at all. Replaces the old
          // "already paid → no-op" check, which stopped being a correct
          // idempotency test the moment an invoice could take a second payment:
          // a partially-paid invoice is still 'sent', so status alone can no
          // longer distinguish a re-delivery from a genuine follow-on payment.
          // The real idempotency guard is the unique index on
          // stripe_payment_intent_id, enforced at insert below.
          //
          // 'paid' with existing rows stays eligible (a correction, or an
          // overpayment); 'paid' with none is a legacy header-only settlement
          // whose cash is already booked; draft/voided are refused outright.
          const existingPaymentCount = await paymentCountForInvoice(bootstrapDb, {
            accountId: current.accountId,
            invoiceId,
          });
          const eligible = checkPaymentEligibility({
            status: current.status,
            existingPaymentCount,
          });
          if (!eligible.ok) {
            log.error(
              'stripe webhook ignored for invoice {invoiceId}: {reason} (status {status})',
              { invoiceId, reason: eligible.reason, status: current.status },
            );
            return c.json({ received: true });
          }

          // Currency verification. Trust nothing on the way back in.
          const receivedCents = intent.amount_received ?? 0;
          const expectedCurrency = current.currency.toLowerCase();
          if (intent.currency !== expectedCurrency || receivedCents <= 0) {
            log.error(
              'stripe webhook rejected for invoice {invoiceId}: received {receivedCents} {receivedCurrency}, expected {expectedCurrency}',
              {
                invoiceId,
                receivedCents,
                receivedCurrency: intent.currency,
                expectedCurrency,
              },
            );
            return c.json({ received: true });
          }

          // The amount is no longer required to equal the invoice total.
          // Previously a short capture had to be refused, because the only
          // posting available was "settle the whole balance" and booking that
          // against less money would have invented cash. Now we record exactly
          // what Stripe says it captured, so a partial capture is simply a
          // partial payment and the books stay true by construction.
          const expectedCents = decimalDollarsToCents(current.total);
          if (receivedCents !== expectedCents) {
            log.info(
              'stripe partial payment for invoice {invoiceId}: captured {receivedCents} of {expectedCents}',
              { invoiceId, receivedCents, expectedCents },
            );
          }

          // Processor fee (TMC-156). Stripe deposits net of its cut, so the
          // posting below splits the customer's gross across Dr Cash (net) +
          // Dr Merchant Processing Fees. Fetched before the tx because it's a
          // network call to Stripe and must not hold a DB transaction open.
          // Any failure degrades to null → the pre-TMC-156 gross-cash posting;
          // never fail the webhook over a fee, or a paid invoice ends up with
          // no journal entry at all.
          let feeCents: number | null = null;
          try {
            feeCents = await paymentIntentFeeCents(deps.stripe.client, intent, event.account);
          } catch (err) {
            log.error(
              'stripe fee lookup failed for invoice {invoiceId}; posting cash at gross: {err}',
              { invoiceId, err },
            );
          }
          if (feeCents !== null && (feeCents < 0 || feeCents >= receivedCents)) {
            // A fee at-or-above the payment would drive the Cash leg to zero or
            // negative and break the entry. Treat as unusable rather than
            // posting something nonsensical.
            log.error(
              'stripe fee {feeCents} out of range for invoice {invoiceId} payment {receivedCents}; posting cash at gross',
              { feeCents, invoiceId, receivedCents },
            );
            feeCents = null;
          }
          const processingFee = feeCents === null ? null : centsToMoney(feeCents);

          const now = new Date();
          // The day the money arrived, in the BUSINESS's zone (TMC-258). The
          // manual mark-paid path has resolved this through company.timezone
          // since TMC-196; the Stripe path never did, so two routes to the same
          // invoice_payments table disagreed about what day it was. A card paid
          // at 9:13pm US Central was filed on tomorrow — and on 31 December
          // that is income booked into the wrong tax year.
          const [payee] = await bootstrapDb
            .select({ timezone: companies.timezone })
            .from(companies)
            .where(eq(companies.id, current.companyId))
            .limit(1);
          const receivedOn = localDay(now, payee?.timezone ?? 'UTC');
          // Wrap the payment insert + audit + ledger posting in one tx so the
          // deferred sum-to-zero trigger on journal_lines fires at commit
          // (auto-commit per statement would fail mid-posting) and a posting
          // failure rolls the receipt back rather than leaving money recorded
          // with no journal entry.
          await bootstrapDb.transaction(async (tx) => {
            // Idempotency, enforced by the database rather than by a status
            // read. Stripe re-delivers, and two concurrent deliveries both pass
            // any SELECT-time guard; the unique index on
            // stripe_payment_intent_id is the only check that holds under a
            // race. A conflict means we already booked this intent, so the
            // insert returns nothing and the whole tx becomes a no-op.
            //
            // deposit_account_id is deliberately left unset, which resolves to
            // the primary money account (TMC-207). There is no user at the
            // keyboard on a webhook, and card settlements land wherever Stripe
            // pays out — the business's main account by definition. Offering a
            // choice here would mean guessing, and guessing wrong banks real
            // money into the wrong account with nothing on screen to correct.
            const [payment] = await tx
              .insert(invoicePayments)
              .values({
                id: uuidv7(),
                accountId: current.accountId,
                companyId: current.companyId,
                invoiceId,
                amount: centsToMoney(receivedCents),
                receivedOn,
                // Stamped server-side, never user-submitted — 'stripe' is
                // deliberately absent from INVOICE_PAYMENT_METHODS.
                method: 'stripe',
                processingFee,
                stripePaymentIntentId: intent.id,
              })
              .onConflictDoNothing()
              .returning();
            if (!payment) return;

            // Dr Cash (net) + Dr Merchant Processing Fees / Cr AR (gross) for
            // THIS receipt. The fee legs collapse away when processingFee is
            // null, exactly as before.
            await postInvoicePayment(tx, {
              payment,
              invoice: current,
              accountId: current.accountId,
              companyId: current.companyId,
              postedAt: now,
            });

            // Derives status from the rows and writes the header to agree —
            // the same single path the in-app routes use, so the webhook cannot
            // reach a state the manual flow could not.
            const synced = await syncInvoiceSettlement(tx, {
              accountId: current.accountId,
              invoiceId,
              totalCents: expectedCents,
              // Always true on this path — a Stripe charge can only reach an
              // invoice the customer was sent a link to — but stated rather
              // than assumed, so the webhook cannot drift from the other four
              // settlement writers (TMC-215).
              issued: current.sentAt !== null,
            });

            // Search reindex is NOT needed here: syncInvoiceSettlement above
            // reprojects the invoice itself, in this same tx, because it is the
            // single funnel every settlement path runs through. Adding a second
            // call would only duplicate it.
            //
            // Audit row attributed to the synthetic system user (migration
            // 0009 seeded it specifically for this kind of provider callback).
            // bootstrapDb path — RLS would otherwise hide the row from the
            // tenant role on read; the policy on audit_events allows the
            // superuser unconditionally.
            await tx.insert(auditEvents).values({
              id: uuidv7(),
              accountId: current.accountId,
              companyId: current.companyId,
              actorUserId: SYSTEM_USER_ID,
              entityType: 'invoice',
              entityId: invoiceId,
              action: 'stripe-paid',
              before: { status: current.status, paidAt: current.paidAt },
              after: {
                status: synced?.invoice.status ?? current.status,
                paidAt: synced?.invoice.paidAt ?? null,
                settlement: synced?.summary.settlement,
                amount: payment.amount,
              },
            });
          });

          // Tell the owner the money landed (TMC-230). Until now this handler
          // posted the ledger, wrote an audit row and returned — the operator
          // found out by opening the app and noticing. Best-effort and after
          // the ledger work: a notification must never be the reason Stripe
          // gets a non-200 and retries a payment we have already recorded.
          const [payer] = await bootstrapDb
            .select({ name: contacts.name })
            .from(contacts)
            .where(eq(contacts.id, current.contactId))
            .limit(1);
          await notifyOwner(bootstrapDb, {
            accountId: current.accountId,
            mailer: deps.mailer,
            emailFrom: deps.emailFrom,
            notice: invoicePaidNotice({
              customerName: payer?.name ?? 'A customer',
              number: current.number,
              // What Stripe actually captured, which is not always the invoice
              // total — a short capture is a partial payment, and the note has
              // to say the amount that arrived rather than the amount owed.
              amount: centsToMoney(receivedCents),
              currency: current.currency,
            }),
          });

          return c.json({ received: true });
        }

        // Connect onboarding lifecycle — Stripe pushes account.updated as the
        // connected account moves through details_submitted → charges_enabled.
        // The status route polls our flags rather than calling Stripe, so we
        // need to keep them current. Event.account carries the connected
        // account id; for account.updated, data.object IS the Account, so we
        // could use either — staying with data.object for symmetry with the
        // session branch.
        if (event.type === 'account.updated') {
          const account = event.data.object;
          if (!account.id) return c.json({ received: true });

          const [company] = await bootstrapDb
            .select()
            .from(companies)
            .where(eq(companies.stripeConnectAccountId, account.id))
            .limit(1);
          // Not finding a company is the expected case for the very first
          // account.updated Stripe sends before our /onboard POST has even
          // landed the UPDATE — and for cross-platform misconfiguration
          // where another platform's webhook hits us. 200 so Stripe stops
          // retrying; we'll catch up on the next event.
          if (!company) return c.json({ received: true });

          const facts = accountFacts(account);
          const now = new Date();
          const unchanged =
            company.stripeConnectChargesEnabled === facts.chargesEnabled &&
            company.stripeConnectDetailsSubmitted === facts.detailsSubmitted &&
            company.stripeConnectPayoutsEnabled === facts.payoutsEnabled &&
            company.stripeConnectRequirementsDue === facts.requirementsDue &&
            company.stripeConnectDisabledReason === facts.disabledReason;

          if (unchanged) {
            // No-op delivery (Stripe re-fires events liberally). Nothing to
            // audit — but this IS a fresh confirmation from Stripe, so the sync
            // stamp still moves. Leaving it stale here would make the read-time
            // reconcile (TMC-257) re-ask Stripe about an account it just heard
            // about, on every page load, forever.
            await bootstrapDb
              .update(companies)
              .set({ stripeConnectSyncedAt: now })
              .where(eq(companies.id, company.id));
            return c.json({ received: true });
          }

          const [updated] = await bootstrapDb
            .update(companies)
            .set({
              stripeConnectChargesEnabled: facts.chargesEnabled,
              stripeConnectDetailsSubmitted: facts.detailsSubmitted,
              stripeConnectPayoutsEnabled: facts.payoutsEnabled,
              stripeConnectRequirementsDue: facts.requirementsDue,
              stripeConnectDisabledReason: facts.disabledReason,
              stripeConnectSyncedAt: now,
              updatedAt: now,
            })
            .where(eq(companies.id, company.id))
            .returning();
          if (!updated) return c.json({ received: true });

          await bootstrapDb.insert(auditEvents).values({
            id: uuidv7(),
            accountId: company.accountId,
            companyId: company.id,
            actorUserId: SYSTEM_USER_ID,
            entityType: 'company',
            entityId: company.id,
            // No search reindex: `company` is not a searchable entity and no
            // document carries a company name, so this webhook cannot make the
            // index stale. Pinned by a test asserting search_documents is
            // untouched across this callback, so it stays closed by evidence
            // rather than by belief.
            action: 'stripe-connect-update',
            before: {
              stripeConnectChargesEnabled: company.stripeConnectChargesEnabled,
              stripeConnectDetailsSubmitted: company.stripeConnectDetailsSubmitted,
              stripeConnectPayoutsEnabled: company.stripeConnectPayoutsEnabled,
              stripeConnectRequirementsDue: company.stripeConnectRequirementsDue,
              stripeConnectDisabledReason: company.stripeConnectDisabledReason,
            },
            after: {
              stripeConnectChargesEnabled: updated.stripeConnectChargesEnabled,
              stripeConnectDetailsSubmitted: updated.stripeConnectDetailsSubmitted,
              stripeConnectPayoutsEnabled: updated.stripeConnectPayoutsEnabled,
              stripeConnectRequirementsDue: updated.stripeConnectRequirementsDue,
              stripeConnectDisabledReason: updated.stripeConnectDisabledReason,
            },
          });

          return c.json({ received: true });
        }

        return c.json({ received: true });
      })
      // Resend delivery webhook (TMC-226). Tells us what happened to an email
      // AFTER the send call returned 200 — delivered, bounced, marked as spam.
      //
      // Same posture as the Stripe webhook above: no tenant context, the
      // signature is the authorization, and every outcome that needs no action
      // still answers 200 so the provider stops retrying. The one difference is
      // that this endpoint is optional infrastructure — without the secret it
      // refuses rather than degrades, because an unverified delivery report is
      // an open door to writing "bounced" onto any document whose message id
      // someone can guess.
      .post('/api/webhooks/resend', async (c) => {
        if (!deps.resendWebhookSecret) return c.json({ error: 'resend_not_configured' }, 503);

        // Raw bytes: the signature covers exactly what was sent, so re-parsing
        // and re-serialising would break verification on any payload whose key
        // order or whitespace we did not reproduce.
        const rawBody = await c.req.text();
        const verified = verifyResendSignature({
          secret: deps.resendWebhookSecret,
          headers: {
            id: c.req.header('svix-id'),
            timestamp: c.req.header('svix-timestamp'),
            signature: c.req.header('svix-signature'),
          },
          rawBody,
        });
        if (!verified.ok) {
          // Logged for the same reason the Stripe branch logs: a delivery we
          // cannot verify looks exactly like no delivery at all, and that is
          // how an endpoint silently stops working after a secret rotation.
          log.error('resend webhook signature verification failed: {reason}', {
            reason: verified.reason,
          });
          return c.json({ error: 'invalid_signature' }, 400);
        }

        let payload: unknown;
        try {
          payload = JSON.parse(rawBody);
        } catch {
          return c.json({ error: 'invalid_payload' }, 400);
        }

        const event = mapResendEvent(payload);
        // Nothing to apply: an event type we do not act on, a soft bounce, or a
        // delay. Acknowledged, not an error.
        if (!event) return c.json({ received: true });

        const outcome = await applyProviderEvent(bootstrapDb, event);
        if (outcome === 'unknown_message') {
          // The ordinary case for the account's non-document mail —
          // verification, password resets, statements. Debug, not error: at
          // Resend's volume an error line here would bury the ones that matter.
          log.debug('resend webhook for a message that is not a document: {messageId}', {
            messageId: event.messageId,
          });
        }
        return c.json({ received: true });
      })
  );
}

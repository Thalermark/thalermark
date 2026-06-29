import {
  type Database,
  SYSTEM_USER_ID,
  auditEvents,
  companies,
  contacts,
  estimateLineItems,
  estimates,
  invoiceLineItems,
  invoices,
} from '@thalermark/db';
import { getLogger } from '@thalermark/logger';
import { and, asc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { v7 as uuidv7 } from 'uuid';
import type { AppDeps } from '../app.js';
import { postInvoiceTransition } from '../lib/ledger.js';
import { UUID_RE } from '../lib/route-helpers.js';
import { decimalDollarsToCents } from '../lib/stripe.js';
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
            taxable: invoiceLineItems.taxable,
            taxRatePct: invoiceLineItems.taxRatePct,
            taxAmount: invoiceLineItems.taxAmount,
          })
          .from(invoiceLineItems)
          .where(eq(invoiceLineItems.invoiceId, invoice.id))
          .orderBy(asc(invoiceLineItems.position));

        // Connect routing: if the company has onboarded a connected account,
        // the pay button requires Stripe to have flipped charges_enabled on
        // their side. Self-host companies (no connectAccountId) pay through
        // the platform's STRIPE_SECRET_KEY — 8.5c behavior preserved.
        // connectPending surfaces the mid-onboarding state to the recipient
        // so the page can render a friendly "setting up payments" banner
        // rather than just hiding the Pay button without explanation.
        const hasConnect = !!company?.stripeConnectAccountId;
        const connectReady = !hasConnect || company?.stripeConnectChargesEnabled === true;
        const connectPending = hasConnect && !connectReady;

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

        return c.json({
          number: invoice.number,
          status: invoice.status,
          issueDate: invoice.issueDate,
          dueDate: invoice.dueDate,
          currency: invoice.currency,
          subtotal: invoice.subtotal,
          tax: invoice.tax,
          total: invoice.total,
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
          connectPending,
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
          const amountCents = decimalDollarsToCents(invoice.total);
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

        return c.json({
          number: estimate.number,
          status: estimate.status,
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
        publicEstimateRespond(c, bootstrapDb, 'accept'),
      )
      .post('/api/public/estimates/:token/decline', async (c) =>
        publicEstimateRespond(c, bootstrapDb, 'decline'),
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
          event = await deps.stripe.client.webhooks.constructEventAsync(
            rawBody,
            sig,
            deps.stripe.webhookSecret,
          );
        } catch {
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
          // Already-paid is the idempotent case (Stripe re-delivery, double-
          // submit). 200 so Stripe stops retrying; no audit row.
          if (current.status === 'paid') return c.json({ received: true });
          // Other terminal states (voided, draft-without-send) — should not
          // happen because the payment-intent mint guards on status=sent, but
          // a PI created out-of-band could land here. 200 + no-op so
          // the webhook queue drains; the manual reconciliation is on the
          // operator at that point.
          if (current.status !== 'sent') return c.json({ received: true });

          // Amount + currency verification. We minted the PaymentIntent for the
          // invoice total, but trust nothing on the way back in: confirm Stripe
          // actually captured that exact amount and currency before reconciling
          // as paid-in-full. amount_received is what was collected (cents); a
          // mismatch — partial capture, a stale intent against a since-changed
          // total, or a crafted event — must not post Dr Cash / Cr AR for the
          // full balance. Acknowledge 200 so Stripe stops retrying (the amount
          // won't change on redelivery) but leave the invoice 'sent' for the
          // operator to reconcile by hand.
          const expectedCents = decimalDollarsToCents(current.total);
          const receivedCents = intent.amount_received ?? 0;
          const expectedCurrency = current.currency.toLowerCase();
          if (receivedCents !== expectedCents || intent.currency !== expectedCurrency) {
            log.error(
              'stripe webhook payment mismatch for invoice {invoiceId}: expected {expectedCents} {expectedCurrency}, received {receivedCents} {receivedCurrency}',
              {
                invoiceId,
                expectedCents,
                expectedCurrency,
                receivedCents,
                receivedCurrency: intent.currency,
              },
            );
            return c.json({ received: true });
          }

          const now = new Date();
          // Wrap the status flip + audit + ledger posting in one tx so
          // the deferred sum-to-zero trigger on journal_lines fires at
          // commit (auto-commit per statement would fail mid-posting)
          // and a posting failure rolls the status flip back rather than
          // leaving a paid invoice with no journal entry.
          await bootstrapDb.transaction(async (tx) => {
            const [updated] = await tx
              .update(invoices)
              // Stamp the channel so the detail page reads "Paid via Card
              // (Stripe)" consistently with the manual mark-paid methods.
              .set({ status: 'paid', paidAt: now, updatedAt: now, paymentMethod: 'stripe' })
              // Re-assert status='sent' inside the UPDATE so concurrent
              // deliveries (or a webhook overlapping a manual mark-paid) can't
              // both post. The SELECT guard above runs outside any lock; under
              // READ COMMITTED the losing UPDATE re-evaluates this predicate
              // against the freshly committed row, matches 0 rows, and bails
              // before the ledger posting double-counts Dr Cash / Cr AR.
              .where(and(eq(invoices.id, invoiceId), eq(invoices.status, 'sent')))
              .returning();
            if (!updated) return;

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
              after: { status: updated.status, paidAt: updated.paidAt },
            });

            // Ledger posting (slice L2). Webhook only fires sent → paid
            // (current.status === 'sent' guard above), so the posting is
            // always Dr Cash / Cr AR.
            await postInvoiceTransition(tx, {
              invoice: updated,
              prevStatus: 'sent',
              nextStatus: 'paid',
              accountId: current.accountId,
              companyId: current.companyId,
              postedAt: now,
            });
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

          const nextCharges = account.charges_enabled === true;
          const nextDetails = account.details_submitted === true;
          if (
            company.stripeConnectChargesEnabled === nextCharges &&
            company.stripeConnectDetailsSubmitted === nextDetails
          ) {
            // No-op delivery (Stripe re-fires events liberally). Idempotent,
            // no audit row.
            return c.json({ received: true });
          }

          const now = new Date();
          const [updated] = await bootstrapDb
            .update(companies)
            .set({
              stripeConnectChargesEnabled: nextCharges,
              stripeConnectDetailsSubmitted: nextDetails,
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
            action: 'stripe-connect-update',
            before: {
              stripeConnectChargesEnabled: company.stripeConnectChargesEnabled,
              stripeConnectDetailsSubmitted: company.stripeConnectDetailsSubmitted,
            },
            after: {
              stripeConnectChargesEnabled: updated.stripeConnectChargesEnabled,
              stripeConnectDetailsSubmitted: updated.stripeConnectDetailsSubmitted,
            },
          });

          return c.json({ received: true });
        }

        return c.json({ received: true });
      })
  );
}

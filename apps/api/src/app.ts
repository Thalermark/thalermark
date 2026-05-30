import { randomBytes } from 'node:crypto';
import {
  type Database,
  SYSTEM_USER_ID,
  accounts,
  auditEvents,
  authUser,
  companies,
  customers,
  estimateLineItems,
  estimates,
  invitations,
  invoiceLineItems,
  invoices,
  memberships,
} from '@thalermark/db';
import {
  customerCreateSchema,
  customerUpdateSchema,
  estimateCreateSchema,
  estimateSendSchema,
  estimateUpdateSchema,
  invoiceCreateSchema,
  invoiceSendSchema,
  invoiceUpdateSchema,
} from '@thalermark/validation';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { validator } from 'hono/validator';
import { v7 as uuidv7 } from 'uuid';
import type { ApiAuth } from './lib/auth.js';
import { postInvoiceTransition } from './lib/ledger.js';
import type { Mailer } from './lib/mailer.js';
import { type StripeBundle, decimalDollarsToCents } from './lib/stripe.js';
import { type RlsVariables, rlsContext } from './middleware/rls-context.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Inline HTML escaper for the invoice-send email body. The recipient's mail
// client renders the HTML, and number / customer name / company name are
// all user-supplied free text — a `<script>` in a company name would
// otherwise ride out to every customer.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Smart-detect: increment the trailing integer of the company's most recent
// invoice number while keeping prefix + zero-padding intact. Preserves
// whatever convention the user adopted ("INV-0042" → "INV-0043",
// "2026-007" → "2026-008", "42" → "43"). No prior invoice OR no trailing
// integer → the locked first-invoice default "INV-0001". Single source of
// truth for the suggestion lives here in the API so mobile can hit the same
// endpoint without re-deriving.
const FIRST_INVOICE_DEFAULT = 'INV-0001';
const FIRST_ESTIMATE_DEFAULT = 'EST-0001';
const TRAILING_INT_RE = /^(.*?)(\d+)$/;

function nextNumberWithDefault(latest: string | undefined, defaultValue: string): string {
  if (!latest) return defaultValue;
  const match = TRAILING_INT_RE.exec(latest);
  if (!match) return defaultValue;
  const [, prefix, digits] = match;
  const next = (BigInt(digits ?? '0') + 1n).toString();
  const padded = next.padStart((digits ?? '').length, '0');
  return `${prefix ?? ''}${padded}`;
}

// Invoice status state machine. Allowed transitions:
//   draft → sent     (mark-sent)
//   draft → paid     (mark-paid, manual mark-paid without sending)
//   sent  → paid     (mark-paid)
//   draft → voided   (void)
//   sent  → voided   (void)
// `paid` and `voided` are terminal. Each transition stamps its dedicated
// timestamp column; the stamps are write-once via the state machine. Driven
// off a single table so the three endpoints below stay symmetric and any
// future transition (e.g. `unvoid`) is a one-line addition here.
type InvoiceStatus = 'draft' | 'sent' | 'paid' | 'voided';
type TransitionKey = 'mark-sent' | 'mark-paid' | 'void';
type TransitionSpec = {
  from: readonly InvoiceStatus[];
  to: InvoiceStatus;
  stamp: 'sentAt' | 'paidAt' | 'voidedAt';
};
const INVOICE_TRANSITIONS: Record<TransitionKey, TransitionSpec> = {
  'mark-sent': { from: ['draft'], to: 'sent', stamp: 'sentAt' },
  'mark-paid': { from: ['draft', 'sent'], to: 'paid', stamp: 'paidAt' },
  void: { from: ['draft', 'sent'], to: 'voided', stamp: 'voidedAt' },
};

async function transitionInvoice(
  c: Context<{ Variables: RlsVariables }>,
  id: string,
  key: TransitionKey,
  spec: TransitionSpec,
) {
  if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
  const tx = c.get('tx');
  const accountId = c.get('accountId');

  const [current] = await tx
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, id), eq(invoices.accountId, accountId)))
    .limit(1);
  if (!current) return c.json({ error: 'invoice_not_found' }, 404);

  if (!(spec.from as readonly string[]).includes(current.status)) {
    return c.json({ error: 'invalid_transition', from: current.status, to: spec.to }, 409);
  }

  const now = new Date();
  const patch: Record<string, unknown> = {
    status: spec.to,
    updatedAt: now,
    [spec.stamp]: now,
  };
  // mark-sent mints the public-view token if the invoice doesn't have one
  // yet. 32 random bytes hex matches the invitation token pattern (large
  // enough that brute-force enumeration is uneconomical even without rate
  // limiting). Idempotent: a future re-send transition would keep the same
  // token so the shared URL stays stable for the recipient.
  if (key === 'mark-sent' && !current.publicToken) {
    patch.publicToken = randomBytes(32).toString('hex');
  }
  const [updated] = await tx
    .update(invoices)
    .set(patch)
    .where(and(eq(invoices.id, id), eq(invoices.accountId, accountId)))
    .returning();
  if (!updated) return c.json({ error: 'invoice_not_found' }, 404);

  await c.var.audit({
    entityType: 'invoice',
    entityId: id,
    action: key,
    before: {
      status: current.status,
      sentAt: current.sentAt,
      paidAt: current.paidAt,
      voidedAt: current.voidedAt,
      publicToken: current.publicToken,
    },
    after: {
      status: updated.status,
      sentAt: updated.sentAt,
      paidAt: updated.paidAt,
      voidedAt: updated.voidedAt,
      publicToken: updated.publicToken,
    },
    companyId: updated.companyId,
  });

  // Ledger posting (slice L2). Runs inside the same tenant tx so the
  // deferred sum-to-zero trigger on journal_lines fires at commit and a
  // posting failure rolls the status flip + audit back together. Empty-
  // amount transitions (draft → voided, total=0 invoice) post nothing.
  await postInvoiceTransition(tx, {
    invoice: updated,
    prevStatus: current.status as InvoiceStatus,
    nextStatus: updated.status as InvoiceStatus,
    accountId,
    companyId: updated.companyId,
    postedAt: now,
  });

  return c.json(updated);
}

export function suggestNextInvoiceNumber(latest: string | undefined): string {
  return nextNumberWithDefault(latest, FIRST_INVOICE_DEFAULT);
}

export function suggestNextEstimateNumber(latest: string | undefined): string {
  return nextNumberWithDefault(latest, FIRST_ESTIMATE_DEFAULT);
}

// Estimate status state machine. Allowed transitions:
//   draft → sent      (mark-sent — mints public_token, same pattern as invoice)
//   draft → accepted  (mark-accepted — operator captured a verbal close)
//   sent  → accepted  (mark-accepted — customer agreed; public-page route in 8.7e)
//   draft → declined  (mark-declined — operator captured a verbal decline)
//   sent  → declined  (mark-declined — customer said no; public-page in 8.7e)
// `accepted` and `declined` are operationally terminal in MVP (convert-to-
// invoice is a separate link action, not a status change). `expired` flips
// advisory-at-read off expires_on; no transition endpoint until pg-boss
// lands a background sweep.
type EstimateStatus = 'draft' | 'sent' | 'accepted' | 'declined' | 'expired';
type EstimateTransitionKey = 'mark-sent' | 'mark-accepted' | 'mark-declined';
type EstimateTransitionSpec = {
  from: readonly EstimateStatus[];
  to: EstimateStatus;
  stamp: 'sentAt' | 'acceptedAt' | 'declinedAt';
};
const ESTIMATE_TRANSITIONS: Record<EstimateTransitionKey, EstimateTransitionSpec> = {
  'mark-sent': { from: ['draft'], to: 'sent', stamp: 'sentAt' },
  'mark-accepted': { from: ['draft', 'sent'], to: 'accepted', stamp: 'acceptedAt' },
  'mark-declined': { from: ['draft', 'sent'], to: 'declined', stamp: 'declinedAt' },
};

async function transitionEstimate(
  c: Context<{ Variables: RlsVariables }>,
  id: string,
  key: EstimateTransitionKey,
  spec: EstimateTransitionSpec,
) {
  if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
  const tx = c.get('tx');
  const accountId = c.get('accountId');

  const [current] = await tx
    .select()
    .from(estimates)
    .where(and(eq(estimates.id, id), eq(estimates.accountId, accountId)))
    .limit(1);
  if (!current) return c.json({ error: 'estimate_not_found' }, 404);

  if (!(spec.from as readonly string[]).includes(current.status)) {
    return c.json({ error: 'invalid_transition', from: current.status, to: spec.to }, 409);
  }

  const now = new Date();
  const patch: Record<string, unknown> = {
    status: spec.to,
    updatedAt: now,
    [spec.stamp]: now,
  };
  // mark-sent mints the public-view token (same 32-byte pattern as the
  // invoice public token); idempotent for a future resend.
  if (key === 'mark-sent' && !current.publicToken) {
    patch.publicToken = randomBytes(32).toString('hex');
  }
  const [updated] = await tx
    .update(estimates)
    .set(patch)
    .where(and(eq(estimates.id, id), eq(estimates.accountId, accountId)))
    .returning();
  if (!updated) return c.json({ error: 'estimate_not_found' }, 404);

  await c.var.audit({
    entityType: 'estimate',
    entityId: id,
    action: key,
    before: {
      status: current.status,
      sentAt: current.sentAt,
      acceptedAt: current.acceptedAt,
      declinedAt: current.declinedAt,
      publicToken: current.publicToken,
    },
    after: {
      status: updated.status,
      sentAt: updated.sentAt,
      acceptedAt: updated.acceptedAt,
      declinedAt: updated.declinedAt,
      publicToken: updated.publicToken,
    },
    companyId: updated.companyId,
  });

  return c.json(updated);
}

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

export type AppDeps = {
  auth: ApiAuth;
  db: Database;
  // Superuser/BYPASSRLS handle for the narrow bootstrap surface that runs
  // before a tenant context exists: /api/me's "what accounts do I belong to"
  // and rls-context's membership probe. The RLS policies on accounts and
  // memberships gate visibility on `app.current_account_id`, which isn't set
  // on these requests, so under the tenant role they'd return zero rows.
  // Optional because integration tests run as the testcontainer superuser
  // and have nothing to distinguish; production server.ts passes both.
  bootstrapDb?: Database;
  scheduleFlush?: (db: Database, accountId: string) => void;
  trustedOrigins?: string[];
  publicAppUrl?: string;
  // Email transport for the invoice-send + invitation endpoints. Optional so
  // integration tests that don't exercise either can omit it; routes that
  // need it fail fast with 500 when called without a mailer wired in.
  mailer?: Mailer;
  emailFrom?: string;
  // Stripe SDK bundle (client + publishable key + webhook secret). Null
  // when the operator hasn't configured STRIPE_* env vars — the public-
  // invoice view checks for null and hides the Pay button rather than
  // erroring; the webhook route returns 503 in that state.
  stripe?: StripeBundle | null;
};

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Routes are chained so Hono's type system carries each route's path + handler
// shape through to AppType, which Phase 4's packages/api-contract re-exports
// for hc<AppType>() clients. Breaking the chain (e.g. `app.get(...); app.get(...)`)
// erases that schema back to an empty Hono.
export function createApp(deps: AppDeps) {
  const origins = deps.trustedOrigins ?? [];
  const bootstrapDb = deps.bootstrapDb ?? deps.db;
  return (
    new Hono<{ Variables: RlsVariables }>()
      .get('/health', (c) => c.json({ status: 'ok' }))
      .use(
        '/api/*',
        cors({
          origin: (incoming) => (origins.includes(incoming) ? incoming : null),
          credentials: true,
          allowHeaders: ['Content-Type', 'x-account-id', 'Authorization'],
          allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
          // set-auth-token is the bearer plugin's session-token echo. Browsers
          // hide non-CORS-safelisted response headers from JS unless exposed
          // here, so the mobile (and Expo Web) client can read + persist it.
          exposeHeaders: ['set-auth-token'],
        }),
      )
      .on(['GET', 'POST'], '/api/auth/*', (c) => deps.auth.handler(c.req.raw))
      .use(
        '/api/*',
        rlsContext({
          auth: deps.auth,
          db: deps.db,
          bootstrapDb,
          scheduleFlush: deps.scheduleFlush,
        }),
      )
      .get('/api/me', async (c) => {
        const userId = c.get('userId');
        const [user] = await bootstrapDb
          .select({
            id: authUser.id,
            email: authUser.email,
            name: authUser.name,
            lastAccountId: authUser.lastAccountId,
          })
          .from(authUser)
          .where(eq(authUser.id, userId));
        if (!user) return c.json({ error: 'unauthorized' }, 401);
        const rows = await bootstrapDb
          .select({ accountId: memberships.accountId, name: accounts.name })
          .from(memberships)
          .innerJoin(accounts, eq(memberships.accountId, accounts.id))
          .where(eq(memberships.userId, userId));
        return c.json({ user, memberships: rows });
      })
      .post('/api/invitations', async (c) => {
        const body = (await c.req.json().catch(() => null)) as { email?: unknown } | null;
        const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
        if (!EMAIL_RE.test(email)) return c.json({ error: 'invalid_email' }, 400);

        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const inviterId = c.get('userId');
        const id = uuidv7();
        const token = randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

        await tx.insert(invitations).values({
          id,
          accountId,
          email,
          token,
          invitedByUserId: inviterId,
          expiresAt,
        });

        const path = `/accept-invite?token=${token}`;
        const url = deps.publicAppUrl ? `${deps.publicAppUrl}${path}` : path;

        if (!deps.mailer) {
          // server.ts always wires a mailer (console driver is the fallback
          // when RESEND_API_KEY is unset), so reaching this branch means the
          // caller built createApp without wiring one — misconfig, fail fast.
          return c.json({ error: 'mailer_not_configured' }, 500);
        }
        try {
          // Email I/O sits outside the tenant tx: the invitation row already
          // committed when this returns, and a mailer 5xx surfaces as 502
          // without rolling back the insert. The token is recoverable from
          // the row if the user retries; the alternative (rollback) silently
          // discards an invitation the caller saw acknowledged.
          await deps.mailer.send({
            to: email,
            subject: 'You have been invited to Thalermark',
            text: `You have been invited to join an account on Thalermark.\n\nAccept the invitation: ${url}\n\nThe link expires in 7 days.\n`,
            html: `<p>You have been invited to join an account on Thalermark.</p><p><a href="${escapeHtml(url)}">Accept invitation</a></p><p>The link expires in 7 days.</p>`,
          });
        } catch {
          return c.json({ error: 'mailer_send_failed' }, 502);
        }

        return c.json({ id, email, token, expiresAt: expiresAt.toISOString() }, 201);
      })
      .post('/api/invitations/:token/accept', async (c) => {
        // Bootstrap path: rls-context set userId from the session but did not
        // open a tenant tx (the accepting user is not yet a member). Use the
        // raw db; uniqueness on token + the freshness checks below are enough.
        const userId = c.get('userId');
        const [user] = await deps.db
          .select({ id: authUser.id, email: authUser.email })
          .from(authUser)
          .where(eq(authUser.id, userId));
        if (!user) return c.json({ error: 'unauthorized' }, 401);

        const token = c.req.param('token');
        const [invite] = await deps.db
          .select()
          .from(invitations)
          .where(and(eq(invitations.token, token), isNull(invitations.acceptedAt)));
        if (!invite) return c.json({ error: 'invite_not_found' }, 404);
        if (invite.expiresAt.getTime() < Date.now())
          return c.json({ error: 'invite_expired' }, 410);
        if (invite.email.toLowerCase() !== user.email.toLowerCase()) {
          return c.json({ error: 'invite_email_mismatch' }, 403);
        }

        const acceptedAt = new Date();
        await deps.db.transaction(async (tx) => {
          await tx
            .insert(memberships)
            .values({ id: uuidv7(), userId: user.id, accountId: invite.accountId })
            .onConflictDoNothing({ target: [memberships.userId, memberships.accountId] });
          await tx
            .update(invitations)
            .set({ acceptedAt, acceptedByUserId: user.id, updatedAt: acceptedAt })
            .where(eq(invitations.id, invite.id));
        });

        return c.json({ accountId: invite.accountId });
      })
      .get('/api/companies', async (c) => {
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        // Explicit account_id filter on every domain query — defense in depth
        // for the case where the DB role bypasses RLS (the integration tests
        // run as the testcontainer superuser; production currently does too
        // until the api flips to thalermark_app). Belt + braces with the RLS
        // policies.
        const rows = await tx
          .select({ id: companies.id, name: companies.name })
          .from(companies)
          .where(eq(companies.accountId, accountId))
          .orderBy(asc(companies.createdAt));
        return c.json({ companies: rows });
      })
      // Stripe Connect onboarding — kicks off (or refreshes) the Stripe-hosted
      // onboarding flow for SaaS multi-tenant payment routing. Lazily creates
      // an Express connected account on first call, stamps its id on the
      // company, and mints an Account Link the client redirects to. Idempotent
      // — subsequent calls reuse the stored acct_xxx and just mint a fresh
      // link (the previous one will have expired or been consumed). The
      // checkout-session minter at /api/public/invoices/:token/checkout-session
      // doesn't change in this slice; flipping it to route via stripeAccount
      // is 8.5e's job.
      .post('/api/companies/:id/stripe-connect/onboard', async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        if (!deps.stripe) return c.json({ error: 'stripe_not_configured' }, 503);
        if (!deps.publicAppUrl) return c.json({ error: 'public_url_not_configured' }, 503);

        const tx = c.get('tx');
        const accountId = c.get('accountId');

        const [company] = await tx
          .select()
          .from(companies)
          .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
          .limit(1);
        if (!company) return c.json({ error: 'company_not_found' }, 404);

        let connectAccountId = company.stripeConnectAccountId;
        if (!connectAccountId) {
          // Idempotency key on the Stripe call guards against double-click
          // racing two concurrent POSTs through both branches before either
          // UPDATE wins. Stripe returns the same account id on retry rather
          // than creating a second one.
          const created = await deps.stripe.client.accounts.create(
            {
              type: 'express',
              country: 'US',
              capabilities: {
                card_payments: { requested: true },
                transfers: { requested: true },
              },
              business_profile: { name: company.name },
            },
            { idempotencyKey: `company-${id}-create-account` },
          );
          connectAccountId = created.id;
          const now = new Date();
          await tx
            .update(companies)
            .set({ stripeConnectAccountId: connectAccountId, updatedAt: now })
            .where(and(eq(companies.id, id), eq(companies.accountId, accountId)));
          await c.var.audit({
            entityType: 'company',
            entityId: id,
            action: 'stripe-connect-create',
            before: { stripeConnectAccountId: null },
            after: { stripeConnectAccountId: connectAccountId },
            companyId: id,
          });
        }

        const link = await deps.stripe.client.accountLinks.create({
          account: connectAccountId,
          refresh_url: `${deps.publicAppUrl}/settings/payments?stripe=refresh`,
          return_url: `${deps.publicAppUrl}/settings/payments?stripe=return`,
          type: 'account_onboarding',
        });

        return c.json({ url: link.url, accountId: connectAccountId });
      })
      // Current state of the Connect onboarding for this company. The web
      // /settings/payments page polls this on the ?stripe=return landing so
      // it can resolve "submitted, waiting on Stripe verification" vs
      // "charges enabled" without forcing another round-trip to Stripe.
      // The flags are kept fresh by the account.updated webhook branch.
      .get('/api/companies/:id/stripe-connect/status', async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);

        const tx = c.get('tx');
        const accountId = c.get('accountId');

        const [company] = await tx
          .select({
            stripeConnectAccountId: companies.stripeConnectAccountId,
            stripeConnectChargesEnabled: companies.stripeConnectChargesEnabled,
            stripeConnectDetailsSubmitted: companies.stripeConnectDetailsSubmitted,
          })
          .from(companies)
          .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
          .limit(1);
        if (!company) return c.json({ error: 'company_not_found' }, 404);

        return c.json({
          stripeConfigured: deps.stripe != null,
          stripeConnectAccountId: company.stripeConnectAccountId,
          stripeConnectChargesEnabled: company.stripeConnectChargesEnabled,
          stripeConnectDetailsSubmitted: company.stripeConnectDetailsSubmitted,
        });
      })
      .post('/api/customers', async (c) => {
        const body = await c.req.json().catch(() => null);
        const parsed = customerCreateSchema.safeParse(body);
        if (!parsed.success) {
          return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
        }

        const tx = c.get('tx');
        const accountId = c.get('accountId');

        const [company] = await tx
          .select({ id: companies.id })
          .from(companies)
          .where(and(eq(companies.id, parsed.data.companyId), eq(companies.accountId, accountId)))
          .limit(1);
        if (!company) return c.json({ error: 'company_not_found' }, 404);

        const id = uuidv7();
        const row = { id, accountId, ...parsed.data };
        await tx.insert(customers).values(row);
        await c.var.audit({
          entityType: 'customer',
          entityId: id,
          action: 'create',
          after: row,
          companyId: parsed.data.companyId,
        });

        return c.json(row, 201);
      })
      .get('/api/customers', async (c) => {
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const companyId = c.req.query('companyId');
        const conditions = [eq(customers.accountId, accountId)];
        if (companyId) conditions.push(eq(customers.companyId, companyId));
        const rows = await tx
          .select()
          .from(customers)
          .where(and(...conditions));
        return c.json({ customers: rows });
      })
      .get('/api/customers/:id', async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const [row] = await tx
          .select()
          .from(customers)
          .where(and(eq(customers.id, id), eq(customers.accountId, accountId)));
        if (!row) return c.json({ error: 'customer_not_found' }, 404);
        return c.json(row);
      })
      // hono/validator middleware: lifts the json body into the typed Input
      // so hc<AppType>() infers `{ param, json }` on .$patch. Without it the
      // client would only see `{ param }` (path-param-only) and reject the
      // body argument at compile time. Also lets the handler drop the
      // duplicated safeParse — c.req.valid('json') hands back the parsed
      // shape, and the validator returns the 400 itself.
      .patch(
        '/api/customers/:id',
        validator('json', (value, c) => {
          const parsed = customerUpdateSchema.safeParse(value);
          if (!parsed.success) {
            return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
          }
          return parsed.data;
        }),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
          const data = c.req.valid('json');

          const tx = c.get('tx');
          const accountId = c.get('accountId');

          const [before] = await tx
            .select()
            .from(customers)
            .where(and(eq(customers.id, id), eq(customers.accountId, accountId)))
            .limit(1);
          if (!before) return c.json({ error: 'customer_not_found' }, 404);

          // Full-replacement semantics — undefined optionals clear the column.
          // The DB columns for optional fields are nullable, so collapsing
          // undefined → null keeps the DB state symmetric with what the form
          // submitted rather than leaving stale values around.
          const patch = {
            name: data.name,
            email: data.email ?? null,
            phone: data.phone ?? null,
            addressLine1: data.addressLine1 ?? null,
            addressLine2: data.addressLine2 ?? null,
            city: data.city ?? null,
            region: data.region ?? null,
            postalCode: data.postalCode ?? null,
            country: data.country ?? null,
            notes: data.notes ?? null,
            updatedAt: new Date(),
          };
          const [after] = await tx
            .update(customers)
            .set(patch)
            .where(and(eq(customers.id, id), eq(customers.accountId, accountId)))
            .returning();
          if (!after) return c.json({ error: 'customer_not_found' }, 404);

          await c.var.audit({
            entityType: 'customer',
            entityId: id,
            action: 'update',
            before,
            after,
            companyId: before.companyId,
          });

          return c.json(after);
        },
      )
      .post('/api/invoices', async (c) => {
        const body = await c.req.json().catch(() => null);
        const parsed = invoiceCreateSchema.safeParse(body);
        if (!parsed.success) {
          return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
        }

        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const { companyId, customerId, lineItems, ...header } = parsed.data;

        // Customer must belong to this account AND match the requested companyId.
        // The schema does not enforce the customer↔company link at the DB level
        // (customers carry companyId; invoices independently set companyId), so
        // we check it here to avoid an invoice that disagrees with its customer.
        const [customer] = await tx
          .select({ id: customers.id, companyId: customers.companyId })
          .from(customers)
          .where(and(eq(customers.id, customerId), eq(customers.accountId, accountId)))
          .limit(1);
        if (!customer) return c.json({ error: 'customer_not_found' }, 404);
        if (customer.companyId !== companyId) {
          return c.json({ error: 'customer_company_mismatch' }, 400);
        }

        // Pre-check the (company_id, number) unique constraint so we can return
        // a clean 409 without aborting the tenant tx (a constraint violation
        // would poison the tx and force the rls-context wrapper to roll back
        // everything, including any audit row we'd want to write).
        const [taken] = await tx
          .select({ id: invoices.id })
          .from(invoices)
          .where(
            and(
              eq(invoices.accountId, accountId),
              eq(invoices.companyId, companyId),
              eq(invoices.number, header.number),
            ),
          )
          .limit(1);
        if (taken) return c.json({ error: 'invoice_number_taken' }, 409);

        const invoiceId = uuidv7();
        await tx.insert(invoices).values({
          id: invoiceId,
          accountId,
          companyId,
          customerId,
          ...header,
        });
        const lineRows = lineItems.map((li) => ({
          id: uuidv7(),
          accountId,
          invoiceId,
          ...li,
        }));
        await tx.insert(invoiceLineItems).values(lineRows);

        await c.var.audit({
          entityType: 'invoice',
          entityId: invoiceId,
          action: 'create',
          after: { id: invoiceId, ...parsed.data },
          companyId,
        });

        return c.json({ id: invoiceId, ...parsed.data }, 201);
      })
      .get('/api/invoices', async (c) => {
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const companyId = c.req.query('companyId');
        const status = c.req.query('status');
        const conditions = [eq(invoices.accountId, accountId)];
        if (companyId) conditions.push(eq(invoices.companyId, companyId));
        if (status) conditions.push(eq(invoices.status, status));
        const rows = await tx
          .select()
          .from(invoices)
          .where(and(...conditions))
          .orderBy(asc(invoices.createdAt));
        return c.json({ invoices: rows });
      })
      .get('/api/invoices/next-number', async (c) => {
        // Must be declared before /api/invoices/:id — Hono is first-match, and
        // 'next-number' would otherwise hit the :id handler and fail the UUID
        // regex with a 400.
        const companyId = c.req.query('companyId');
        if (!companyId || !UUID_RE.test(companyId)) {
          return c.json({ error: 'invalid_company_id' }, 400);
        }
        const tx = c.get('tx');
        const accountId = c.get('accountId');

        const [company] = await tx
          .select({ id: companies.id })
          .from(companies)
          .where(and(eq(companies.id, companyId), eq(companies.accountId, accountId)))
          .limit(1);
        if (!company) return c.json({ error: 'company_not_found' }, 404);

        const [latest] = await tx
          .select({ number: invoices.number })
          .from(invoices)
          .where(and(eq(invoices.accountId, accountId), eq(invoices.companyId, companyId)))
          .orderBy(desc(invoices.createdAt))
          .limit(1);

        return c.json({ suggestion: suggestNextInvoiceNumber(latest?.number) });
      })
      .get('/api/invoices/:id', async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const [invoice] = await tx
          .select()
          .from(invoices)
          .where(and(eq(invoices.id, id), eq(invoices.accountId, accountId)));
        if (!invoice) return c.json({ error: 'invoice_not_found' }, 404);
        const lines = await tx
          .select()
          .from(invoiceLineItems)
          .where(and(eq(invoiceLineItems.invoiceId, id), eq(invoiceLineItems.accountId, accountId)))
          .orderBy(asc(invoiceLineItems.position));
        return c.json({ ...invoice, lineItems: lines });
      })
      .patch(
        '/api/invoices/:id',
        validator('json', (value, c) => {
          const parsed = invoiceUpdateSchema.safeParse(value);
          if (!parsed.success) {
            return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
          }
          return parsed.data;
        }),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
          const data = c.req.valid('json');

          const tx = c.get('tx');
          const accountId = c.get('accountId');
          const { customerId, lineItems, ...header } = data;

          const [current] = await tx
            .select()
            .from(invoices)
            .where(and(eq(invoices.id, id), eq(invoices.accountId, accountId)))
            .limit(1);
          if (!current) return c.json({ error: 'invoice_not_found' }, 404);

          // Edits are draft-only. Once an invoice is sent / paid / voided the
          // numbers + line items are part of the customer-facing record and
          // mutating them silently is a footgun (and an audit-trail
          // misdirection — the audit row would say "update" but the
          // counterparty has the old version). Future work: allow corrections
          // that explicitly supersede a sent invoice with a credit note.
          if (current.status !== 'draft') {
            return c.json({ error: 'not_editable', status: current.status }, 409);
          }

          // customerId is mutable on edit, so the customer↔company invariant
          // needs the same check the create endpoint does. companyId is fixed
          // (omitted from the update schema) — the invoice cannot move
          // between companies — so we compare against current.companyId.
          const [customer] = await tx
            .select({ id: customers.id, companyId: customers.companyId })
            .from(customers)
            .where(and(eq(customers.id, customerId), eq(customers.accountId, accountId)))
            .limit(1);
          if (!customer) return c.json({ error: 'customer_not_found' }, 404);
          if (customer.companyId !== current.companyId) {
            return c.json({ error: 'customer_company_mismatch' }, 400);
          }

          // Same 409 pre-check as create: if the number changed and the new
          // one is taken, return cleanly without poisoning the tenant tx.
          // Numbers are unique per (account_id, company_id) — no-op when
          // nothing changed.
          if (header.number !== current.number) {
            const [taken] = await tx
              .select({ id: invoices.id })
              .from(invoices)
              .where(
                and(
                  eq(invoices.accountId, accountId),
                  eq(invoices.companyId, current.companyId),
                  eq(invoices.number, header.number),
                ),
              )
              .limit(1);
            if (taken) return c.json({ error: 'invoice_number_taken' }, 409);
          }

          // Read the existing lines so the audit row diff carries the prior
          // state. Done before delete so we don't lose the data on rollback.
          const beforeLines = await tx
            .select()
            .from(invoiceLineItems)
            .where(
              and(eq(invoiceLineItems.invoiceId, id), eq(invoiceLineItems.accountId, accountId)),
            )
            .orderBy(asc(invoiceLineItems.position));

          // Line items: full replacement. Delete the old set, insert the new
          // — simpler than diffing positions + ids, and the edit form always
          // submits the whole set anyway. Both writes run in the same tenant
          // tx so a failure rolls everything back.
          await tx
            .delete(invoiceLineItems)
            .where(
              and(eq(invoiceLineItems.invoiceId, id), eq(invoiceLineItems.accountId, accountId)),
            );
          const newLineRows = lineItems.map((li) => ({
            id: uuidv7(),
            accountId,
            invoiceId: id,
            ...li,
          }));
          await tx.insert(invoiceLineItems).values(newLineRows);

          const [updated] = await tx
            .update(invoices)
            .set({
              customerId,
              number: header.number,
              issueDate: header.issueDate,
              dueDate: header.dueDate,
              currency: header.currency ?? current.currency,
              subtotal: header.subtotal,
              tax: header.tax ?? '0',
              total: header.total,
              notes: header.notes ?? null,
              updatedAt: new Date(),
            })
            .where(and(eq(invoices.id, id), eq(invoices.accountId, accountId)))
            .returning();
          if (!updated) return c.json({ error: 'invoice_not_found' }, 404);

          await c.var.audit({
            entityType: 'invoice',
            entityId: id,
            action: 'update',
            before: { ...current, lineItems: beforeLines },
            after: { ...updated, lineItems: newLineRows },
            companyId: current.companyId,
          });

          return c.json({ ...updated, lineItems: newLineRows });
        },
      )
      .post('/api/invoices/:id/mark-sent', (c) =>
        transitionInvoice(c, c.req.param('id'), 'mark-sent', INVOICE_TRANSITIONS['mark-sent']),
      )
      .post('/api/invoices/:id/mark-paid', (c) =>
        transitionInvoice(c, c.req.param('id'), 'mark-paid', INVOICE_TRANSITIONS['mark-paid']),
      )
      .post('/api/invoices/:id/void', (c) =>
        transitionInvoice(c, c.req.param('id'), 'void', INVOICE_TRANSITIONS.void),
      )
      // Estimates — same shape as invoices minus dueDate and minus the pay
      // path. Mirrors invoices.* closely (status state machine, audit rows,
      // customer↔company invariant, (company_id, number) uniqueness pre-
      // check, draft-only PATCH). Public route + email send + accept/decline
      // land in slice 8.7e; convert-to-invoice in 8.7d.
      .post('/api/estimates', async (c) => {
        const body = await c.req.json().catch(() => null);
        const parsed = estimateCreateSchema.safeParse(body);
        if (!parsed.success) {
          return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
        }

        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const { companyId, customerId, lineItems, ...header } = parsed.data;

        const [customer] = await tx
          .select({ id: customers.id, companyId: customers.companyId })
          .from(customers)
          .where(and(eq(customers.id, customerId), eq(customers.accountId, accountId)))
          .limit(1);
        if (!customer) return c.json({ error: 'customer_not_found' }, 404);
        if (customer.companyId !== companyId) {
          return c.json({ error: 'customer_company_mismatch' }, 400);
        }

        // (company_id, number) pre-check — same reasoning as invoice POST: a
        // constraint throw would poison the tenant tx and roll back the
        // audit row alongside the business write.
        const [taken] = await tx
          .select({ id: estimates.id })
          .from(estimates)
          .where(
            and(
              eq(estimates.accountId, accountId),
              eq(estimates.companyId, companyId),
              eq(estimates.number, header.number),
            ),
          )
          .limit(1);
        if (taken) return c.json({ error: 'estimate_number_taken' }, 409);

        const estimateId = uuidv7();
        await tx.insert(estimates).values({
          id: estimateId,
          accountId,
          companyId,
          customerId,
          ...header,
        });
        const lineRows = lineItems.map((li) => ({
          id: uuidv7(),
          accountId,
          estimateId,
          ...li,
        }));
        await tx.insert(estimateLineItems).values(lineRows);

        await c.var.audit({
          entityType: 'estimate',
          entityId: estimateId,
          action: 'create',
          after: { id: estimateId, ...parsed.data },
          companyId,
        });

        return c.json({ id: estimateId, ...parsed.data }, 201);
      })
      .get('/api/estimates', async (c) => {
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const companyId = c.req.query('companyId');
        const status = c.req.query('status');
        const conditions = [eq(estimates.accountId, accountId)];
        if (companyId) conditions.push(eq(estimates.companyId, companyId));
        if (status) conditions.push(eq(estimates.status, status));
        const rows = await tx
          .select()
          .from(estimates)
          .where(and(...conditions))
          .orderBy(asc(estimates.createdAt));
        return c.json({ estimates: rows });
      })
      .get('/api/estimates/next-number', async (c) => {
        // Declared before /api/estimates/:id — Hono is first-match, same as
        // the invoice next-number route. Without this ordering 'next-number'
        // would land in the :id handler and 400 on the UUID regex.
        const companyId = c.req.query('companyId');
        if (!companyId || !UUID_RE.test(companyId)) {
          return c.json({ error: 'invalid_company_id' }, 400);
        }
        const tx = c.get('tx');
        const accountId = c.get('accountId');

        const [company] = await tx
          .select({ id: companies.id })
          .from(companies)
          .where(and(eq(companies.id, companyId), eq(companies.accountId, accountId)))
          .limit(1);
        if (!company) return c.json({ error: 'company_not_found' }, 404);

        const [latest] = await tx
          .select({ number: estimates.number })
          .from(estimates)
          .where(and(eq(estimates.accountId, accountId), eq(estimates.companyId, companyId)))
          .orderBy(desc(estimates.createdAt))
          .limit(1);

        return c.json({ suggestion: suggestNextEstimateNumber(latest?.number) });
      })
      .get('/api/estimates/:id', async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const [estimate] = await tx
          .select()
          .from(estimates)
          .where(and(eq(estimates.id, id), eq(estimates.accountId, accountId)));
        if (!estimate) return c.json({ error: 'estimate_not_found' }, 404);
        const lines = await tx
          .select()
          .from(estimateLineItems)
          .where(
            and(eq(estimateLineItems.estimateId, id), eq(estimateLineItems.accountId, accountId)),
          )
          .orderBy(asc(estimateLineItems.position));
        return c.json({ ...estimate, lineItems: lines });
      })
      .patch(
        '/api/estimates/:id',
        validator('json', (value, c) => {
          const parsed = estimateUpdateSchema.safeParse(value);
          if (!parsed.success) {
            return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
          }
          return parsed.data;
        }),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
          const data = c.req.valid('json');

          const tx = c.get('tx');
          const accountId = c.get('accountId');
          const { customerId, lineItems, ...header } = data;

          const [current] = await tx
            .select()
            .from(estimates)
            .where(and(eq(estimates.id, id), eq(estimates.accountId, accountId)))
            .limit(1);
          if (!current) return c.json({ error: 'estimate_not_found' }, 404);

          // Draft-only edits, mirroring invoices. Once an estimate has been
          // sent the recipient has a copy; mutating silently is a footgun
          // (and an audit-trail misdirection). Accepted / declined are
          // terminal records; expired is advisory.
          if (current.status !== 'draft') {
            return c.json({ error: 'not_editable', status: current.status }, 409);
          }

          const [customer] = await tx
            .select({ id: customers.id, companyId: customers.companyId })
            .from(customers)
            .where(and(eq(customers.id, customerId), eq(customers.accountId, accountId)))
            .limit(1);
          if (!customer) return c.json({ error: 'customer_not_found' }, 404);
          if (customer.companyId !== current.companyId) {
            return c.json({ error: 'customer_company_mismatch' }, 400);
          }

          if (header.number !== current.number) {
            const [taken] = await tx
              .select({ id: estimates.id })
              .from(estimates)
              .where(
                and(
                  eq(estimates.accountId, accountId),
                  eq(estimates.companyId, current.companyId),
                  eq(estimates.number, header.number),
                ),
              )
              .limit(1);
            if (taken) return c.json({ error: 'estimate_number_taken' }, 409);
          }

          const beforeLines = await tx
            .select()
            .from(estimateLineItems)
            .where(
              and(eq(estimateLineItems.estimateId, id), eq(estimateLineItems.accountId, accountId)),
            )
            .orderBy(asc(estimateLineItems.position));

          await tx
            .delete(estimateLineItems)
            .where(
              and(eq(estimateLineItems.estimateId, id), eq(estimateLineItems.accountId, accountId)),
            );
          const newLineRows = lineItems.map((li) => ({
            id: uuidv7(),
            accountId,
            estimateId: id,
            ...li,
          }));
          await tx.insert(estimateLineItems).values(newLineRows);

          const [updated] = await tx
            .update(estimates)
            .set({
              customerId,
              number: header.number,
              issueDate: header.issueDate,
              expiresOn: header.expiresOn ?? null,
              currency: header.currency ?? current.currency,
              subtotal: header.subtotal,
              tax: header.tax ?? '0',
              total: header.total,
              notes: header.notes ?? null,
              updatedAt: new Date(),
            })
            .where(and(eq(estimates.id, id), eq(estimates.accountId, accountId)))
            .returning();
          if (!updated) return c.json({ error: 'estimate_not_found' }, 404);

          await c.var.audit({
            entityType: 'estimate',
            entityId: id,
            action: 'update',
            before: { ...current, lineItems: beforeLines },
            after: { ...updated, lineItems: newLineRows },
            companyId: current.companyId,
          });

          return c.json({ ...updated, lineItems: newLineRows });
        },
      )
      .post('/api/estimates/:id/mark-sent', (c) =>
        transitionEstimate(c, c.req.param('id'), 'mark-sent', ESTIMATE_TRANSITIONS['mark-sent']),
      )
      .post('/api/estimates/:id/mark-accepted', (c) =>
        transitionEstimate(
          c,
          c.req.param('id'),
          'mark-accepted',
          ESTIMATE_TRANSITIONS['mark-accepted'],
        ),
      )
      .post('/api/estimates/:id/mark-declined', (c) =>
        transitionEstimate(
          c,
          c.req.param('id'),
          'mark-declined',
          ESTIMATE_TRANSITIONS['mark-declined'],
        ),
      )
      // Convert an accepted estimate into a draft invoice. Gated to status
      // 'accepted' — the "estimate → agreement → invoice" flow. Idempotent:
      // a second call (or a re-load that fires the action twice) returns the
      // existing invoice id instead of creating a duplicate. The estimate's
      // status does not change here; convert is a link action, not a status
      // transition (the comment on ESTIMATE_TRANSITIONS up top calls this
      // out). Invoice number is auto-generated server-side via the same
      // suggestNextInvoiceNumber pipeline the /next-number endpoint uses;
      // (companyId, number) is pre-checked inside the tx for the same
      // reason the invoice POST pre-checks — a constraint throw would
      // poison the tenant tx and roll back the audit rows.
      .post('/api/estimates/:id/convert', async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        const tx = c.get('tx');
        const accountId = c.get('accountId');

        const [estimate] = await tx
          .select()
          .from(estimates)
          .where(and(eq(estimates.id, id), eq(estimates.accountId, accountId)))
          .limit(1);
        if (!estimate) return c.json({ error: 'estimate_not_found' }, 404);

        // Idempotent re-call: if the link is already set, return that
        // invoice id without writing anything. Keeps double-submits + the
        // browser back/forward pattern from minting a second invoice.
        if (estimate.convertedInvoiceId) {
          return c.json({ id: estimate.convertedInvoiceId });
        }

        if (estimate.status !== 'accepted') {
          return c.json(
            { error: 'invalid_transition', from: estimate.status, to: 'converted' },
            409,
          );
        }

        const estimateLines = await tx
          .select()
          .from(estimateLineItems)
          .where(
            and(eq(estimateLineItems.estimateId, id), eq(estimateLineItems.accountId, accountId)),
          )
          .orderBy(asc(estimateLineItems.position));

        // Server-side defaults for the new invoice. Issue date is today,
        // due date is today + 30d (Net 30). Operator can edit either via
        // the draft invoice's PATCH path before sending.
        const today = new Date();
        const todayIso = today.toISOString().slice(0, 10);
        const dueIso = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10);

        const [latest] = await tx
          .select({ number: invoices.number })
          .from(invoices)
          .where(and(eq(invoices.accountId, accountId), eq(invoices.companyId, estimate.companyId)))
          .orderBy(desc(invoices.createdAt))
          .limit(1);
        const invoiceNumber = suggestNextInvoiceNumber(latest?.number);

        const [taken] = await tx
          .select({ id: invoices.id })
          .from(invoices)
          .where(
            and(
              eq(invoices.accountId, accountId),
              eq(invoices.companyId, estimate.companyId),
              eq(invoices.number, invoiceNumber),
            ),
          )
          .limit(1);
        if (taken) return c.json({ error: 'invoice_number_collision', number: invoiceNumber }, 409);

        const invoiceId = uuidv7();
        await tx.insert(invoices).values({
          id: invoiceId,
          accountId,
          companyId: estimate.companyId,
          customerId: estimate.customerId,
          number: invoiceNumber,
          issueDate: todayIso,
          dueDate: dueIso,
          currency: estimate.currency,
          subtotal: estimate.subtotal,
          tax: estimate.tax,
          total: estimate.total,
          notes: estimate.notes,
        });
        if (estimateLines.length > 0) {
          await tx.insert(invoiceLineItems).values(
            estimateLines.map((li) => ({
              id: uuidv7(),
              accountId,
              invoiceId,
              position: li.position,
              description: li.description,
              quantity: li.quantity,
              unitPrice: li.unitPrice,
              amount: li.amount,
            })),
          );
        }

        await tx
          .update(estimates)
          .set({ convertedInvoiceId: invoiceId, updatedAt: today })
          .where(and(eq(estimates.id, id), eq(estimates.accountId, accountId)));

        await c.var.audit({
          entityType: 'estimate',
          entityId: id,
          action: 'convert',
          before: { convertedInvoiceId: null },
          after: { convertedInvoiceId: invoiceId },
          companyId: estimate.companyId,
        });
        await c.var.audit({
          entityType: 'invoice',
          entityId: invoiceId,
          action: 'create',
          after: {
            id: invoiceId,
            companyId: estimate.companyId,
            customerId: estimate.customerId,
            number: invoiceNumber,
            issueDate: todayIso,
            dueDate: dueIso,
            currency: estimate.currency,
            subtotal: estimate.subtotal,
            tax: estimate.tax,
            total: estimate.total,
            notes: estimate.notes,
            convertedFromEstimateId: id,
          },
          companyId: estimate.companyId,
        });

        return c.json({ id: invoiceId }, 201);
      })
      // Send the invoice via email. Distinct from /mark-sent (pure status
      // transition, no I/O) because this endpoint adds a real side-effect
      // and an optional recipient override. State machine: draft → sent +
      // email; sent → email only (resend, public_token already idempotent
      // from 8.5a); paid/voided → 409. Email I/O runs after the status
      // transition + status audit row but BEFORE the email-sent audit row;
      // mailer failure surfaces as a 502 and the tx still commits the flip
      // (a Resend 5xx must not silently roll back a successful mark-sent
      // and leave the audit trail lying about what happened — the user
      // retries the send from the UI).
      .post(
        '/api/invoices/:id/send',
        // validator middleware needed for the same reason PATCH endpoints
        // use it (slice 8.4f): path-param routes type Input as `{ param }`
        // and TS rejects `{ param, json }` from hc<AppType>() without the
        // validator lifting the body into the typed Input. Body is fully
        // optional (no override → defaults to customer.email server-side)
        // so empty `{}` is valid.
        validator('json', (value, c) => {
          const parsed = invoiceSendSchema.safeParse(value ?? {});
          if (!parsed.success) {
            return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
          }
          return parsed.data;
        }),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
          if (!deps.mailer) return c.json({ error: 'email_not_configured' }, 500);

          const { to: toOverrideRaw } = c.req.valid('json');
          const toOverride = toOverrideRaw?.trim() || null;

          const tx = c.get('tx');
          const accountId = c.get('accountId');

          const [current] = await tx
            .select()
            .from(invoices)
            .where(and(eq(invoices.id, id), eq(invoices.accountId, accountId)))
            .limit(1);
          if (!current) return c.json({ error: 'invoice_not_found' }, 404);
          if (current.status === 'paid' || current.status === 'voided') {
            return c.json({ error: 'invalid_transition', from: current.status, to: 'sent' }, 409);
          }

          const [customer] = await tx
            .select({ id: customers.id, name: customers.name, email: customers.email })
            .from(customers)
            .where(and(eq(customers.id, current.customerId), eq(customers.accountId, accountId)))
            .limit(1);
          if (!customer) return c.json({ error: 'customer_not_found' }, 404);

          const to = (toOverride ?? customer.email ?? '').trim();
          if (!to || !EMAIL_RE.test(to)) return c.json({ error: 'invalid_recipient' }, 400);

          const [company] = await tx
            .select({ name: companies.name })
            .from(companies)
            .where(and(eq(companies.id, current.companyId), eq(companies.accountId, accountId)))
            .limit(1);

          // First-send transition: draft → sent, stamps sent_at, mints the
          // public token if missing (same idempotent pattern as mark-sent).
          // Resend leaves status / sent_at / public_token untouched.
          let invoice = current;
          if (current.status === 'draft') {
            const now = new Date();
            const [updated] = await tx
              .update(invoices)
              .set({
                status: 'sent',
                sentAt: now,
                updatedAt: now,
                publicToken: current.publicToken ?? randomBytes(32).toString('hex'),
              })
              .where(and(eq(invoices.id, id), eq(invoices.accountId, accountId)))
              .returning();
            if (!updated) return c.json({ error: 'invoice_not_found' }, 404);
            invoice = updated;

            await c.var.audit({
              entityType: 'invoice',
              entityId: id,
              action: 'mark-sent',
              before: {
                status: current.status,
                sentAt: current.sentAt,
                paidAt: current.paidAt,
                voidedAt: current.voidedAt,
                publicToken: current.publicToken,
              },
              after: {
                status: updated.status,
                sentAt: updated.sentAt,
                paidAt: updated.paidAt,
                voidedAt: updated.voidedAt,
                publicToken: updated.publicToken,
              },
              companyId: updated.companyId,
            });
          }

          if (!invoice.publicToken) {
            return c.json({ error: 'invoice_state_invalid' }, 500);
          }

          const companyName = company?.name ?? 'Thalermark';
          const publicUrl = deps.publicAppUrl
            ? `${deps.publicAppUrl}/i/${invoice.publicToken}`
            : `/i/${invoice.publicToken}`;
          const subject = `Invoice ${invoice.number} from ${companyName}`;
          const greeting = customer.name ? `Hi ${customer.name},` : 'Hi,';
          const text =
            `${greeting}\n\n` +
            `Invoice ${invoice.number} for ${invoice.total} ${invoice.currency} is ready.\n` +
            `Due ${invoice.dueDate}.\n\n` +
            `View it: ${publicUrl}\n\n` +
            `— ${companyName}`;
          // Escape user-controlled fields before embedding in HTML — invoice
          // number, customer name, and company name are all free text and a
          // recipient's email client will render the HTML body.
          const html =
            `<p>${escapeHtml(greeting)}</p>` +
            `<p>Invoice <strong>${escapeHtml(invoice.number)}</strong> for ` +
            `<strong>${escapeHtml(invoice.total)} ${escapeHtml(invoice.currency)}</strong> is ready. ` +
            `Due ${escapeHtml(invoice.dueDate)}.</p>` +
            `<p><a href="${escapeHtml(publicUrl)}">View invoice</a></p>` +
            `<p>— ${escapeHtml(companyName)}</p>`;

          try {
            await deps.mailer.send({ to, subject, html, text });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return c.json({ error: 'email_failed', detail: message }, 502);
          }

          await c.var.audit({
            entityType: 'invoice',
            entityId: id,
            action: 'email-sent',
            after: { to, subject },
            companyId: invoice.companyId,
          });

          return c.json({ ...invoice, sentTo: to });
        },
      )
      // Send the estimate via email. Mirrors invoice /send: draft → sent
      // first call (stamps sent_at, mints public_token), resend on sent
      // emails only without mutating state. Accepted / declined / expired
      // are terminal for the send action — 409. The estimate body links to
      // the unauthed /e/<token> page that accept/decline POST against.
      .post(
        '/api/estimates/:id/send',
        validator('json', (value, c) => {
          const parsed = estimateSendSchema.safeParse(value ?? {});
          if (!parsed.success) {
            return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
          }
          return parsed.data;
        }),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
          if (!deps.mailer) return c.json({ error: 'email_not_configured' }, 500);

          const { to: toOverrideRaw } = c.req.valid('json');
          const toOverride = toOverrideRaw?.trim() || null;

          const tx = c.get('tx');
          const accountId = c.get('accountId');

          const [current] = await tx
            .select()
            .from(estimates)
            .where(and(eq(estimates.id, id), eq(estimates.accountId, accountId)))
            .limit(1);
          if (!current) return c.json({ error: 'estimate_not_found' }, 404);
          // Accepted / declined / expired are operationally closed — sending
          // again would muddle the audit trail. Operator who wants a fresh
          // round of correspondence should duplicate the estimate.
          if (
            current.status === 'accepted' ||
            current.status === 'declined' ||
            current.status === 'expired'
          ) {
            return c.json({ error: 'invalid_transition', from: current.status, to: 'sent' }, 409);
          }

          const [customer] = await tx
            .select({ id: customers.id, name: customers.name, email: customers.email })
            .from(customers)
            .where(and(eq(customers.id, current.customerId), eq(customers.accountId, accountId)))
            .limit(1);
          if (!customer) return c.json({ error: 'customer_not_found' }, 404);

          const to = (toOverride ?? customer.email ?? '').trim();
          if (!to || !EMAIL_RE.test(to)) return c.json({ error: 'invalid_recipient' }, 400);

          const [company] = await tx
            .select({ name: companies.name })
            .from(companies)
            .where(and(eq(companies.id, current.companyId), eq(companies.accountId, accountId)))
            .limit(1);

          let estimate = current;
          if (current.status === 'draft') {
            const now = new Date();
            const [updated] = await tx
              .update(estimates)
              .set({
                status: 'sent',
                sentAt: now,
                updatedAt: now,
                publicToken: current.publicToken ?? randomBytes(32).toString('hex'),
              })
              .where(and(eq(estimates.id, id), eq(estimates.accountId, accountId)))
              .returning();
            if (!updated) return c.json({ error: 'estimate_not_found' }, 404);
            estimate = updated;

            await c.var.audit({
              entityType: 'estimate',
              entityId: id,
              action: 'mark-sent',
              before: {
                status: current.status,
                sentAt: current.sentAt,
                acceptedAt: current.acceptedAt,
                declinedAt: current.declinedAt,
                publicToken: current.publicToken,
              },
              after: {
                status: updated.status,
                sentAt: updated.sentAt,
                acceptedAt: updated.acceptedAt,
                declinedAt: updated.declinedAt,
                publicToken: updated.publicToken,
              },
              companyId: updated.companyId,
            });
          }

          if (!estimate.publicToken) {
            return c.json({ error: 'estimate_state_invalid' }, 500);
          }

          const companyName = company?.name ?? 'Thalermark';
          const publicUrl = deps.publicAppUrl
            ? `${deps.publicAppUrl}/e/${estimate.publicToken}`
            : `/e/${estimate.publicToken}`;
          const subject = `Estimate ${estimate.number} from ${companyName}`;
          const greeting = customer.name ? `Hi ${customer.name},` : 'Hi,';
          const expiresLine = estimate.expiresOn ? `Valid until ${estimate.expiresOn}.\n` : '';
          const text = `${greeting}\n\nEstimate ${estimate.number} for ${estimate.total} ${estimate.currency} is ready for your review.\n${expiresLine}\nView it: ${publicUrl}\n\n— ${companyName}`;
          const expiresHtml = estimate.expiresOn
            ? ` Valid until ${escapeHtml(estimate.expiresOn)}.`
            : '';
          const html = `<p>${escapeHtml(greeting)}</p><p>Estimate <strong>${escapeHtml(estimate.number)}</strong> for <strong>${escapeHtml(estimate.total)} ${escapeHtml(estimate.currency)}</strong> is ready for your review.${expiresHtml}</p><p><a href="${escapeHtml(publicUrl)}">View estimate</a></p><p>— ${escapeHtml(companyName)}</p>`;

          try {
            await deps.mailer.send({ to, subject, html, text });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return c.json({ error: 'email_failed', detail: message }, 502);
          }

          await c.var.audit({
            entityType: 'estimate',
            entityId: id,
            action: 'email-sent',
            after: { to, subject },
            companyId: estimate.companyId,
          });

          return c.json({ ...estimate, sentTo: to });
        },
      )
      // Audit-events read endpoint. Two modes off the same surface:
      //   - **Per-entity** (entityType + entityId): full history for one
      //     record; used by the per-entity History sections on
      //     customer/invoice/estimate detail pages (slice 8.8a).
      //   - **Feed** (both omitted): account-wide recent activity, used by
      //     the /activity page (slice 8.8b). Bounded by `limit` (default 50,
      //     max 200) so a hot account doesn't ship the entire audit table.
      // Both modes resolve actor_user_id → display name in one join; the
      // synthetic system user (auth_user.is_system, seeded migration 0009)
      // renders as "System" so provider-driven rows (stripe-paid,
      // public-accept/decline) are attributed without leaking the system
      // uuid. Feed mode additionally enriches each row with `entityLabel`
      // — invoice/estimate `number` or customer `name` — via one inArray
      // lookup per entity type (3 small queries, not N+1) so the feed UI
      // can render "Invoice INV-0042" without the consumer doing per-row
      // resolution.
      .get('/api/audit-events', async (c) => {
        const entityTypeRaw = c.req.query('entityType');
        const entityIdRaw = c.req.query('entityId');
        const limitRaw = c.req.query('limit');
        const ALLOWED_TYPES = ['customer', 'invoice', 'estimate'] as const;
        type EntityType = (typeof ALLOWED_TYPES)[number];

        // Validation: entityId requires entityType (a bare id is ambiguous);
        // entityType alone is allowed but rare. Empty query = feed mode.
        if (entityTypeRaw !== undefined) {
          if (!(ALLOWED_TYPES as readonly string[]).includes(entityTypeRaw)) {
            return c.json({ error: 'invalid_entity_type' }, 400);
          }
        }
        if (entityIdRaw !== undefined) {
          if (entityTypeRaw === undefined) {
            return c.json({ error: 'entity_id_requires_entity_type' }, 400);
          }
          if (!UUID_RE.test(entityIdRaw)) {
            return c.json({ error: 'invalid_entity_id' }, 400);
          }
        }
        let limit = 50;
        if (limitRaw !== undefined) {
          const parsed = Number.parseInt(limitRaw, 10);
          if (!Number.isFinite(parsed) || parsed <= 0) {
            return c.json({ error: 'invalid_limit' }, 400);
          }
          limit = Math.min(parsed, 200);
        }

        const tx = c.get('tx');
        const accountId = c.get('accountId');

        const conditions = [eq(auditEvents.accountId, accountId)];
        if (entityTypeRaw !== undefined) {
          conditions.push(eq(auditEvents.entityType, entityTypeRaw));
        }
        if (entityIdRaw !== undefined) {
          conditions.push(eq(auditEvents.entityId, entityIdRaw));
        }

        const rows = await tx
          .select({
            id: auditEvents.id,
            action: auditEvents.action,
            entityType: auditEvents.entityType,
            entityId: auditEvents.entityId,
            actorName: authUser.name,
            actorIsSystem: authUser.isSystem,
            createdAt: auditEvents.createdAt,
            before: auditEvents.before,
            after: auditEvents.after,
          })
          .from(auditEvents)
          .leftJoin(authUser, eq(authUser.id, auditEvents.actorUserId))
          .where(and(...conditions))
          .orderBy(desc(auditEvents.createdAt))
          .limit(limit);

        // Entity-label enrichment — feed mode needs human labels next to
        // the action; per-entity mode already knows the entity. Skip the
        // lookups when no rows came back to dodge zero-id `inArray`.
        const feedMode = entityTypeRaw === undefined;
        const labelMap = new Map<string, string>();
        if (feedMode && rows.length > 0) {
          const idsByType: Record<EntityType, string[]> = {
            customer: [],
            invoice: [],
            estimate: [],
          };
          for (const r of rows) {
            if ((ALLOWED_TYPES as readonly string[]).includes(r.entityType)) {
              idsByType[r.entityType as EntityType].push(r.entityId);
            }
          }
          if (idsByType.invoice.length > 0) {
            const invRows = await tx
              .select({ id: invoices.id, label: invoices.number })
              .from(invoices)
              .where(
                and(eq(invoices.accountId, accountId), inArray(invoices.id, idsByType.invoice)),
              );
            for (const r of invRows) labelMap.set(`invoice:${r.id}`, r.label);
          }
          if (idsByType.estimate.length > 0) {
            const estRows = await tx
              .select({ id: estimates.id, label: estimates.number })
              .from(estimates)
              .where(
                and(eq(estimates.accountId, accountId), inArray(estimates.id, idsByType.estimate)),
              );
            for (const r of estRows) labelMap.set(`estimate:${r.id}`, r.label);
          }
          if (idsByType.customer.length > 0) {
            const custRows = await tx
              .select({ id: customers.id, label: customers.name })
              .from(customers)
              .where(
                and(eq(customers.accountId, accountId), inArray(customers.id, idsByType.customer)),
              );
            for (const r of custRows) labelMap.set(`customer:${r.id}`, r.label);
          }
        }

        return c.json({
          events: rows.map((r) => ({
            id: r.id,
            action: r.action,
            entityType: r.entityType,
            entityId: r.entityId,
            entityLabel: feedMode ? (labelMap.get(`${r.entityType}:${r.entityId}`) ?? null) : null,
            actorName: r.actorIsSystem ? 'System' : (r.actorName ?? 'Unknown'),
            createdAt: r.createdAt,
            before: r.before,
            after: r.after,
          })),
        });
      })
      // Public invoice view — unauthed, gated only by the random token in
      // the URL. rls-context skips this path entirely (no session, no
      // tenant), so the handler reads via bootstrapDb (RLS would hide
      // every row under the missing app.current_account_id setting).
      // The recipient sees what a paper invoice would show: header, line
      // items, customer name, sender company name. Account / company ids
      // and the audit trail stay out of the response.
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
            stripeConnectAccountId: companies.stripeConnectAccountId,
            stripeConnectChargesEnabled: companies.stripeConnectChargesEnabled,
          })
          .from(companies)
          .where(eq(companies.id, invoice.companyId))
          .limit(1);
        const [customer] = await bootstrapDb
          .select({ name: customers.name })
          .from(customers)
          .where(eq(customers.id, invoice.customerId))
          .limit(1);
        const lines = await bootstrapDb
          .select({
            id: invoiceLineItems.id,
            position: invoiceLineItems.position,
            description: invoiceLineItems.description,
            quantity: invoiceLineItems.quantity,
            unitPrice: invoiceLineItems.unitPrice,
            amount: invoiceLineItems.amount,
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
          customerName: customer?.name ?? null,
          lineItems: lines,
          // Tell the client whether the Pay button is wirable. Avoids a
          // separate config probe; the recipient's page can branch on this
          // alone without inferring from a 503 on the session-mint call.
          payable: deps.stripe != null && invoice.status === 'sent' && connectReady,
          connectPending,
        });
      })
      // Stripe Embedded Checkout session mint. Lazy — the public-view page
      // only POSTs here when the recipient clicks Pay, so we don't bill a
      // Stripe API call on every passive page load. Status guard mirrors
      // the public-invoice GET's `payable` flag; the duplicate check is
      // deliberate (the client could be stale or hand-crafted).
      .post('/api/public/invoices/:token/checkout-session', async (c) => {
        if (!deps.stripe) return c.json({ error: 'stripe_not_configured' }, 503);
        if (!deps.publicAppUrl) return c.json({ error: 'public_url_not_configured' }, 503);
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

        const session = await deps.stripe.client.checkout.sessions.create(
          {
            // Stripe 22.x renamed this from the older 'embedded' literal; same
            // flow — mounts Stripe-hosted UI inside our page via stripe.js'
            // initEmbeddedCheckout.
            ui_mode: 'embedded_page',
            mode: 'payment',
            // Stripe navigates the parent window here after success. Includes
            // ?paid=1 so the page can render a "payment received, processing"
            // banner immediately even if the webhook hasn't fired yet.
            return_url: `${deps.publicAppUrl}/i/${invoice.publicToken}?paid=1`,
            line_items: [
              {
                price_data: {
                  currency: invoice.currency.toLowerCase(),
                  product_data: { name: `Invoice ${invoice.number}` },
                  unit_amount: amountCents,
                },
                quantity: 1,
              },
            ],
            // Echoed on the webhook event — primary lookup for the
            // invoice-id → mark-paid transition. The webhook resolves the
            // invoice purely by client_reference_id regardless of which
            // account ran the session, so no change is needed on that side.
            // Metadata duplicated so a human reading the Stripe dashboard can
            // also resolve the invoice without poking at our DB.
            client_reference_id: invoice.id,
            metadata: { invoiceId: invoice.id, accountId: invoice.accountId },
          },
          requestOptions,
        );

        return c.json({
          clientSecret: session.client_secret,
          publishableKey: deps.stripe.publishableKey,
        });
      })
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
          .select({ name: companies.name })
          .from(companies)
          .where(eq(companies.id, estimate.companyId))
          .limit(1);
        const [customer] = await bootstrapDb
          .select({ name: customers.name })
          .from(customers)
          .where(eq(customers.id, estimate.customerId))
          .limit(1);
        const lines = await bootstrapDb
          .select({
            id: estimateLineItems.id,
            position: estimateLineItems.position,
            description: estimateLineItems.description,
            quantity: estimateLineItems.quantity,
            unitPrice: estimateLineItems.unitPrice,
            amount: estimateLineItems.amount,
          })
          .from(estimateLineItems)
          .where(eq(estimateLineItems.estimateId, estimate.id))
          .orderBy(asc(estimateLineItems.position));

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

        if (event.type === 'checkout.session.completed') {
          const session = event.data.object;
          if (session.payment_status !== 'paid') {
            return c.json({ received: true });
          }
          const invoiceId = session.client_reference_id;
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
          // happen because checkout-session mint guards on status=sent, but
          // a future PI created out-of-band could land here. 200 + no-op so
          // the webhook queue drains; the manual reconciliation is on the
          // operator at that point.
          if (current.status !== 'sent') return c.json({ received: true });

          const now = new Date();
          // Wrap the status flip + audit + ledger posting in one tx so
          // the deferred sum-to-zero trigger on journal_lines fires at
          // commit (auto-commit per statement would fail mid-posting)
          // and a posting failure rolls the status flip back rather than
          // leaving a paid invoice with no journal entry.
          await bootstrapDb.transaction(async (tx) => {
            const [updated] = await tx
              .update(invoices)
              .set({ status: 'paid', paidAt: now, updatedAt: now })
              .where(eq(invoices.id, invoiceId))
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

export type AppType = ReturnType<typeof createApp>;

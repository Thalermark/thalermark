import { createHash, randomBytes } from 'node:crypto';
import {
  CASH_FLOW_NUDGE_VERSION,
  type CashFlowAdvisor,
  type CashFlowSignals,
  type ExpenseCategorizer,
  type ExtractionResult,
  type ReceiptExtractor,
} from '@thalermark/ai';
import {
  type Database,
  SYSTEM_USER_ID,
  type Transaction,
  accounts,
  auditEvents,
  authUser,
  chartOfAccounts,
  companies,
  customers,
  estimateLineItems,
  estimates,
  expenses,
  invitations,
  invoiceLineItems,
  invoices,
  journalEntries,
  journalLines,
  memberships,
  recurringInvoiceLineItems,
  recurringInvoices,
} from '@thalermark/db';
import { type StorageProvider, readLocalObject, verifyFileToken } from '@thalermark/storage';
import { emit } from '@thalermark/telemetry';
import {
  companyUpdateSchema,
  customerCreateSchema,
  customerUpdateSchema,
  estimateCreateSchema,
  estimateSendSchema,
  estimateUpdateSchema,
  expenseCategorizeSchema,
  expenseCreateSchema,
  expenseUpdateSchema,
  invoiceCreateSchema,
  invoiceMarkPaidSchema,
  invoiceSendSchema,
  invoiceUpdateSchema,
  recurringInvoiceCreateSchema,
  recurringInvoiceUpdateSchema,
} from '@thalermark/validation';
import { and, asc, desc, eq, gte, ilike, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { validator } from 'hono/validator';
import { v7 as uuidv7 } from 'uuid';
import type { ApiAuth } from './lib/auth.js';
import { escapeHtml } from './lib/html.js';
import { sendInvoiceEmail } from './lib/invoice-email.js';
import { suggestNextEstimateNumber, suggestNextInvoiceNumber } from './lib/invoice-number.js';
import {
  arBalance,
  cashFlowNet,
  cashOnHand,
  postExpenseCreate,
  postExpenseReversal,
  postInvoiceTransition,
  repostInvoicePaymentDate,
} from './lib/ledger.js';
import type { Mailer } from './lib/mailer.js';
import { generateOnce } from './lib/recurring.js';
import { formatSender } from './lib/sender.js';
import { type StripeBundle, decimalDollarsToCents } from './lib/stripe.js';
import { type RlsVariables, rlsContext } from './middleware/rls-context.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Inline HTML escaper for the invoice-send email body. The recipient's mail
// client renders the HTML, and number / customer name / company name are
// all user-supplied free text — a `<script>` in a company name would
// otherwise ride out to every customer.
// Escape the LIKE/ILIKE metacharacters so a merchant search for "50%" or
// "a_b" matches literally instead of as wildcards. Drizzle's ilike() uses the
// default backslash escape character, so backslash itself is escaped too.
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// Expense journal entries are dated to the expense's calendar date, not the
// data-entry time — an expense dated Dec 31 entered Jan 2 must land in the
// prior tax period so the Schedule C trial balance is right at year ends.
// `expense_date` is a bare YYYY-MM-DD; postedAt is timestamptz, so we pin it
// to midnight UTC. Invoice transitions post at `now` instead because their
// economic event (sent / paid) genuinely happens at transition time.
function expenseDateToPostedAt(d: string): Date {
  return new Date(`${d}T00:00:00.000Z`);
}

// Receipt capture (slice 8.9g). All tiers; image always saved. 10 MB cap +
// the three formats a phone camera / scanner produces. The mime → extension
// map doubles as the upload allowlist.
const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;
const RECEIPT_MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'application/pdf': 'pdf',
};
const EXT_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  pdf: 'application/pdf',
  webp: 'image/webp',
};

// Company logo upload (shown on invoices). Smaller cap than a receipt — a logo
// is a small raster — and a raster-only allowlist: SVG is deliberately excluded
// since it can carry script and the logo renders on the public, unauthenticated
// invoice page. Same mime → extension shape as RECEIPT_MIME_EXT.
const LOGO_MAX_BYTES = 2 * 1024 * 1024;
const LOGO_MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
// Content-type to serve a stored object with, inferred from its key extension
// (the local-FS adapter doesn't persist content-type metadata).
function mimeForKey(key: string): string {
  const ext = key.slice(key.lastIndexOf('.') + 1).toLowerCase();
  return EXT_MIME[ext] ?? 'application/octet-stream';
}

// Resolves chart_of_accounts row ids to their { code, accountType } within one
// company (scoped by account for defense-in-depth per
// [[architecture_account_id_explicit_filter]]). The expense endpoints use it
// to validate the category/payment account types before posting and to recover
// the codes of an expense's stored accounts when posting a reversal. Returns a
// Map keyed by id; ids that don't resolve are simply absent.
async function resolveCoaAccounts(
  tx: Transaction,
  accountId: string,
  companyId: string,
  ids: string[],
): Promise<Map<string, { code: string; accountType: string }>> {
  const unique = Array.from(new Set(ids));
  if (unique.length === 0) return new Map();
  const rows = await tx
    .select({
      id: chartOfAccounts.id,
      code: chartOfAccounts.code,
      accountType: chartOfAccounts.accountType,
    })
    .from(chartOfAccounts)
    .where(
      and(
        eq(chartOfAccounts.accountId, accountId),
        eq(chartOfAccounts.companyId, companyId),
        inArray(chartOfAccounts.id, unique),
      ),
    );
  return new Map(rows.map((r) => [r.id, { code: r.code, accountType: r.accountType }]));
}

// Offline-payment columns projected for the company PATCH's audit before/after
// and response. Keeps those call sites in lockstep; accepts any row carrying
// the fields (the full company select or the PATCH's returning()).
function paymentMethodsView(row: {
  paymentCashEnabled: boolean;
  paymentCheckEnabled: boolean;
  paymentCheckPayableTo: string | null;
  paymentCheckAddress: string | null;
  paymentVenmoHandle: string | null;
  paymentZelleContact: string | null;
}) {
  return {
    paymentCashEnabled: row.paymentCashEnabled,
    paymentCheckEnabled: row.paymentCheckEnabled,
    paymentCheckPayableTo: row.paymentCheckPayableTo,
    paymentCheckAddress: row.paymentCheckAddress,
    paymentVenmoHandle: row.paymentVenmoHandle,
    paymentZelleContact: row.paymentZelleContact,
  };
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
  // Per-transition extras (mark-paid only, today): `patch` adds columns merged
  // after the base patch (payment method/reference); `effectiveAt` overrides the
  // economic date used for BOTH the status stamp (e.g. paidAt) and the ledger
  // posting date, so a backdated payment lands in the right reporting period.
  // Defaults to now when omitted.
  opts?: { patch?: Record<string, unknown>; effectiveAt?: Date },
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
  // updatedAt is always record-time; the stamp (paidAt/sentAt/voidedAt) uses the
  // economic date, which a caller can backdate via opts.effectiveAt.
  const effectiveAt = opts?.effectiveAt ?? now;
  const patch: Record<string, unknown> = {
    status: spec.to,
    updatedAt: now,
    [spec.stamp]: effectiveAt,
  };
  // mark-sent mints the public-view token if the invoice doesn't have one
  // yet. 32 random bytes hex matches the invitation token pattern (large
  // enough that brute-force enumeration is uneconomical even without rate
  // limiting). Idempotent: a future re-send transition would keep the same
  // token so the shared URL stays stable for the recipient.
  if (key === 'mark-sent' && !current.publicToken) {
    patch.publicToken = randomBytes(32).toString('hex');
  }
  if (opts?.patch) Object.assign(patch, opts.patch);
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
      paymentMethod: current.paymentMethod,
      paymentReference: current.paymentReference,
    },
    after: {
      status: updated.status,
      sentAt: updated.sentAt,
      paidAt: updated.paidAt,
      voidedAt: updated.voidedAt,
      publicToken: updated.publicToken,
      paymentMethod: updated.paymentMethod,
      paymentReference: updated.paymentReference,
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
    postedAt: effectiveAt,
  });

  return c.json(updated);
}

// Recurring-invoice schedule state machine. Allowed transitions:
//   active → paused   (pause — manual hold; sweeper skips paused schedules)
//   paused → active   (resume)
//   active → ended    (end — terminal)
//   paused → ended    (end — terminal)
// `ended` is terminal. An end condition (end_date / max_occurrences) reached
// during generation also moves a schedule to `ended` (slice R3), so the same
// status set is written from two places.
type RecurringStatus = 'active' | 'paused' | 'ended';
type RecurringTransitionKey = 'pause' | 'resume' | 'end';
const RECURRING_TRANSITIONS: Record<
  RecurringTransitionKey,
  { from: readonly RecurringStatus[]; to: RecurringStatus }
> = {
  pause: { from: ['active'], to: 'paused' },
  resume: { from: ['paused'], to: 'active' },
  end: { from: ['active', 'paused'], to: 'ended' },
};

async function transitionRecurringInvoice(
  c: Context<{ Variables: RlsVariables }>,
  id: string,
  key: RecurringTransitionKey,
) {
  if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
  const spec = RECURRING_TRANSITIONS[key];
  const tx = c.get('tx');
  const accountId = c.get('accountId');

  const [current] = await tx
    .select()
    .from(recurringInvoices)
    .where(and(eq(recurringInvoices.id, id), eq(recurringInvoices.accountId, accountId)))
    .limit(1);
  if (!current) return c.json({ error: 'recurring_invoice_not_found' }, 404);

  if (!(spec.from as readonly string[]).includes(current.status)) {
    return c.json({ error: 'invalid_transition', from: current.status, to: spec.to }, 409);
  }

  const now = new Date();
  const patch: Record<string, unknown> = { status: spec.to, updatedAt: now };
  // On resume, if next_run_date is in the past (the schedule was paused
  // through one or more would-be occurrences), pull it forward to today so the
  // next sweep mints a current-dated invoice rather than a back-dated one.
  // next_run_date is an ISO YYYY-MM-DD string, so a lexicographic compare is a
  // date compare. The sweeper's own catch-up collapse (slice R3) covers
  // server-downtime gaps; this covers the deliberate pause case.
  if (key === 'resume') {
    const todayIso = now.toISOString().slice(0, 10);
    if (current.nextRunDate < todayIso) patch.nextRunDate = todayIso;
  }

  const [updated] = await tx
    .update(recurringInvoices)
    .set(patch)
    .where(and(eq(recurringInvoices.id, id), eq(recurringInvoices.accountId, accountId)))
    .returning();
  if (!updated) return c.json({ error: 'recurring_invoice_not_found' }, 404);

  await c.var.audit({
    entityType: 'recurring_invoice',
    entityId: id,
    action: key,
    before: { status: current.status, nextRunDate: current.nextRunDate },
    after: { status: updated.status, nextRunDate: updated.nextRunDate },
    companyId: updated.companyId,
  });

  return c.json(updated);
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
  // Object-storage provider for receipt capture (slice 8.9g). Null when the
  // operator hasn't configured STORAGE_* env vars — the receipt endpoints
  // return 503 in that state, the rest of the app runs. Same opt-in model
  // as stripe/mailer.
  storage?: StorageProvider | null;
  // Local-FS download serving. Only set when STORAGE_DRIVER=local: the
  // /api/files/:token route verifies the token with `secret` and reads bytes
  // from `baseDir`. Null for the s3 driver, whose signed URLs point at the
  // object store directly so /api/files is never hit.
  localFileServe?: { secret: string; baseDir: string } | null;
  // Vision-LLM receipt extractor (slice 8.9h). Null when no LLM provider is
  // configured (anthropic/openai with no LLM_API_KEY, or an unknown provider) —
  // the /extract endpoint 503s in that state. Same opt-in model as
  // stripe/storage. Tests inject a plain stub so no live model is called.
  extractor?: ReceiptExtractor | null;
  // Text-based expense categorizer (AI). Null when no LLM provider is
  // configured — the /categorize endpoint 503s in that state, same opt-in
  // model as the extractor. Distinct from extractor: this reads typed text
  // (fast model), not a receipt image (vision model). Tests inject a stub.
  categorizer?: ExpenseCategorizer | null;
  // Cash-flow nudge advisor (AI, reasoning model). Null when no LLM is
  // configured — the cash-flow-nudges endpoint then 503s unless cached nudges
  // already exist. Tests inject a stub. Generated nudges are cached on the
  // company row and regenerated only when the computed signals change.
  advisor?: CashFlowAdvisor | null;
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
      .get('/api/team', async (c) => {
        // Team management surface (settings/team): current members + the
        // still-open invitations for the active account. MVP gives every
        // member the same role, so there is no role column to return yet.
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const currentUserId = c.get('userId');

        // Members: memberships is the tenant table (RLS-scoped); join authUser
        // for the display name/email the same way /api/audit-events does.
        const memberRows = await tx
          .select({
            userId: memberships.userId,
            name: authUser.name,
            email: authUser.email,
            joinedAt: memberships.createdAt,
          })
          .from(memberships)
          .innerJoin(authUser, eq(authUser.id, memberships.userId))
          .where(eq(memberships.accountId, accountId))
          .orderBy(asc(memberships.createdAt));

        // Pending = not yet accepted. Expired-but-unaccepted rows still show
        // (the page flags them) so the inviter can see a stale invite and
        // re-send rather than wonder where it went.
        const pending = await tx
          .select({
            id: invitations.id,
            email: invitations.email,
            expiresAt: invitations.expiresAt,
            createdAt: invitations.createdAt,
          })
          .from(invitations)
          .where(and(eq(invitations.accountId, accountId), isNull(invitations.acceptedAt)))
          .orderBy(desc(invitations.createdAt));

        return c.json({
          members: memberRows.map((m) => ({
            userId: m.userId,
            name: m.name,
            email: m.email,
            joinedAt: m.joinedAt.toISOString(),
            isYou: m.userId === currentUserId,
          })),
          invitations: pending.map((p) => ({
            id: p.id,
            email: p.email,
            expiresAt: p.expiresAt.toISOString(),
            createdAt: p.createdAt.toISOString(),
            expired: p.expiresAt.getTime() < Date.now(),
          })),
        });
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
          .select({
            id: companies.id,
            name: companies.name,
            businessType: companies.businessType,
            businessAddress: companies.businessAddress,
            businessPhone: companies.businessPhone,
            replyToEmail: companies.replyToEmail,
            paymentCashEnabled: companies.paymentCashEnabled,
            paymentCheckEnabled: companies.paymentCheckEnabled,
            paymentCheckPayableTo: companies.paymentCheckPayableTo,
            paymentCheckAddress: companies.paymentCheckAddress,
            paymentVenmoHandle: companies.paymentVenmoHandle,
            paymentZelleContact: companies.paymentZelleContact,
          })
          .from(companies)
          .where(eq(companies.accountId, accountId))
          .orderBy(asc(companies.createdAt));
        return c.json({ companies: rows });
      })
      // PATCH company — slice L3. Sparse semantics: only the keys present in
      // the body get written. Used by the post-signup business-type wizard
      // (sends { businessType, name? }) and any future rename surface from
      // settings. validator middleware lifts the json body into the typed
      // Input so hc<AppType>() sees `{ param, json }` on .$patch (same shape
      // as the customer/invoice PATCHes).
      .patch(
        '/api/companies/:id',
        validator('json', (value, c) => {
          const parsed = companyUpdateSchema.safeParse(value);
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
            .from(companies)
            .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
            .limit(1);
          if (!before) return c.json({ error: 'company_not_found' }, 404);

          const patch: Record<string, unknown> = { updatedAt: new Date() };
          if (data.name !== undefined) patch.name = data.name;
          if (data.businessType !== undefined) patch.businessType = data.businessType;
          // Business identity — sparse + '' → null, same as replyToEmail below.
          if (data.businessAddress !== undefined) patch.businessAddress = data.businessAddress;
          if (data.businessPhone !== undefined) patch.businessPhone = data.businessPhone;
          // Validation coerces '' → null, so an explicit clear lands as null here.
          if (data.replyToEmail !== undefined) patch.replyToEmail = data.replyToEmail;
          // Offline payment instructions — same sparse + '' → null semantics.
          if (data.paymentCashEnabled !== undefined)
            patch.paymentCashEnabled = data.paymentCashEnabled;
          if (data.paymentCheckEnabled !== undefined)
            patch.paymentCheckEnabled = data.paymentCheckEnabled;
          if (data.paymentCheckPayableTo !== undefined)
            patch.paymentCheckPayableTo = data.paymentCheckPayableTo;
          if (data.paymentCheckAddress !== undefined)
            patch.paymentCheckAddress = data.paymentCheckAddress;
          if (data.paymentVenmoHandle !== undefined)
            patch.paymentVenmoHandle = data.paymentVenmoHandle;
          if (data.paymentZelleContact !== undefined)
            patch.paymentZelleContact = data.paymentZelleContact;

          const [after] = await tx
            .update(companies)
            .set(patch)
            .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
            .returning();
          if (!after) return c.json({ error: 'company_not_found' }, 404);

          await c.var.audit({
            entityType: 'company',
            entityId: id,
            action: 'update',
            before: {
              name: before.name,
              businessType: before.businessType,
              businessAddress: before.businessAddress,
              businessPhone: before.businessPhone,
              replyToEmail: before.replyToEmail,
              ...paymentMethodsView(before),
            },
            after: {
              name: after.name,
              businessType: after.businessType,
              businessAddress: after.businessAddress,
              businessPhone: after.businessPhone,
              replyToEmail: after.replyToEmail,
              ...paymentMethodsView(after),
            },
            companyId: id,
          });

          return c.json({
            id: after.id,
            name: after.name,
            businessType: after.businessType,
            businessAddress: after.businessAddress,
            businessPhone: after.businessPhone,
            replyToEmail: after.replyToEmail,
            ...paymentMethodsView(after),
          });
        },
      )
      // ---- Company logo (shown on invoices) -------------------------------
      // Same upload/serve/delete shape as the expense receipt: multipart in,
      // a time-limited signed URL out, object write/delete as the LAST await so
      // a storage failure rolls the column change back. Raster-only, ≤2MB.
      .post('/api/companies/:id/logo', async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        if (!deps.storage) return c.json({ error: 'storage_not_configured' }, 503);

        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const [company] = await tx
          .select()
          .from(companies)
          .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
          .limit(1);
        if (!company) return c.json({ error: 'company_not_found' }, 404);

        const body = await c.req.parseBody();
        const file = body.file;
        if (!(file instanceof File)) return c.json({ error: 'file_required' }, 400);
        const ext = LOGO_MIME_EXT[file.type];
        if (!ext) {
          return c.json(
            { error: 'unsupported_media_type', allowed: Object.keys(LOGO_MIME_EXT) },
            415,
          );
        }
        if (file.size > LOGO_MAX_BYTES) {
          return c.json({ error: 'file_too_large', maxBytes: LOGO_MAX_BYTES }, 413);
        }
        const bytes = new Uint8Array(await file.arrayBuffer());

        // Re-upload overwrites the column with a fresh key; the prior object is
        // left orphaned (rare, harmless — keys are uuidv7 so no collision).
        const key = `accounts/${accountId}/companies/${id}/branding/${uuidv7()}.${ext}`;

        const [updated] = await tx
          .update(companies)
          .set({ logoStorageKey: key, updatedAt: new Date() })
          .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
          .returning();
        if (!updated) return c.json({ error: 'company_not_found' }, 404);

        await c.var.audit({
          entityType: 'company',
          entityId: id,
          action: 'logo-upload',
          before: { logoStorageKey: company.logoStorageKey },
          after: { logoStorageKey: key },
          companyId: id,
        });

        await deps.storage.putObject({ key, body: bytes, contentType: file.type });

        return c.json({ id, logoStorageKey: key }, 201);
      })
      // 1-hour signed download URL for the authed settings preview. For s3 it's
      // a presigned object-store URL; for local-FS a relative /api/files/<token>.
      .get('/api/companies/:id/logo', async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        if (!deps.storage) return c.json({ error: 'storage_not_configured' }, 503);

        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const [company] = await tx
          .select({ logoStorageKey: companies.logoStorageKey })
          .from(companies)
          .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
          .limit(1);
        if (!company) return c.json({ error: 'company_not_found' }, 404);
        if (!company.logoStorageKey) return c.json({ error: 'no_logo' }, 404);

        const url = await deps.storage.getSignedDownloadUrl(company.logoStorageKey, {
          expiresInSeconds: 3600,
        });
        return c.json({ url, contentType: mimeForKey(company.logoStorageKey) });
      })
      // Remove the logo: null the column + audit, then drop the object as the
      // LAST await so a storage failure rolls the nulling back. Idempotent.
      .delete('/api/companies/:id/logo', async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        if (!deps.storage) return c.json({ error: 'storage_not_configured' }, 503);

        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const [company] = await tx
          .select({ logoStorageKey: companies.logoStorageKey })
          .from(companies)
          .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
          .limit(1);
        if (!company) return c.json({ error: 'company_not_found' }, 404);
        if (!company.logoStorageKey) return c.json({ ok: true });

        const key = company.logoStorageKey;
        await tx
          .update(companies)
          .set({ logoStorageKey: null, updatedAt: new Date() })
          .where(and(eq(companies.id, id), eq(companies.accountId, accountId)));

        await c.var.audit({
          entityType: 'company',
          entityId: id,
          action: 'logo-remove',
          before: { logoStorageKey: key },
          after: { logoStorageKey: null },
          companyId: id,
        });

        await deps.storage.deleteObject(key);
        return c.json({ ok: true });
      })
      // Stripe Connect onboarding — kicks off (or refreshes) the Stripe-hosted
      // onboarding flow for SaaS multi-tenant payment routing. Lazily creates
      // an Express connected account on first call, stamps its id on the
      // company, and mints an Account Link the client redirects to. Idempotent
      // — subsequent calls reuse the stored acct_xxx and just mint a fresh
      // link (the previous one will have expired or been consumed). The
      // payment-intent minter at /api/public/invoices/:token/payment-intent
      // routes the charge to this connected account via the stripeAccount
      // request option (direct charge).
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
      // Slice L4 — GL / trial-balance export. Tenant-scoped read of every
      // journal entry for a company, joined with its COA so the export
      // carries account code + name. Optional from/to date filter (inclusive
      // calendar days; to+1 day on the upper bound). format=json (default)
      // or csv. No pagination in MVP — exports are bulk reads.
      //
      // Single join query (entries × lines × COA) groups in app code so the
      // typed shape on the wire matches what an accountant expects: each
      // entry with its lines nested. Trial balance is computed alongside in
      // a single pass to keep the contract one round-trip.
      .get('/api/companies/:id/ledger/export', async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);

        const tx = c.get('tx');
        const accountId = c.get('accountId');

        const [company] = await tx
          .select({ id: companies.id, name: companies.name })
          .from(companies)
          .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
          .limit(1);
        if (!company) return c.json({ error: 'company_not_found' }, 404);

        const fromRaw = c.req.query('from');
        const toRaw = c.req.query('to');
        const format = c.req.query('format') ?? 'json';
        if (format !== 'json' && format !== 'csv') {
          return c.json({ error: 'invalid_format' }, 400);
        }

        // Date parse: ISO yyyy-mm-dd. Reject non-parseable + flipped ranges
        // (from > to) so the caller catches an off-by-one rather than seeing
        // an empty file and assuming "no activity".
        let fromDate: Date | null = null;
        let toDate: Date | null = null;
        if (fromRaw !== undefined) {
          const d = new Date(`${fromRaw}T00:00:00Z`);
          if (Number.isNaN(d.getTime())) return c.json({ error: 'invalid_from' }, 400);
          fromDate = d;
        }
        if (toRaw !== undefined) {
          const d = new Date(`${toRaw}T00:00:00Z`);
          if (Number.isNaN(d.getTime())) return c.json({ error: 'invalid_to' }, 400);
          // Upper bound is exclusive on (to + 1 day) so to=YYYY-MM-DD pulls in
          // entries posted any time on that day.
          d.setUTCDate(d.getUTCDate() + 1);
          toDate = d;
        }
        if (fromDate && toDate && fromDate >= toDate) {
          return c.json({ error: 'invalid_range' }, 400);
        }

        const whereClauses = [
          eq(journalEntries.companyId, id),
          eq(journalEntries.accountId, accountId),
        ];
        if (fromDate) whereClauses.push(gte(journalEntries.postedAt, fromDate));
        if (toDate) whereClauses.push(lt(journalEntries.postedAt, toDate));

        const rows = await tx
          .select({
            entryId: journalEntries.id,
            postedAt: journalEntries.postedAt,
            sourceEntityType: journalEntries.sourceEntityType,
            sourceEntityId: journalEntries.sourceEntityId,
            memo: journalEntries.memo,
            lineId: journalLines.id,
            side: journalLines.side,
            amount: journalLines.amount,
            code: chartOfAccounts.code,
            accountName: chartOfAccounts.name,
            accountType: chartOfAccounts.accountType,
          })
          .from(journalEntries)
          .innerJoin(journalLines, eq(journalLines.journalEntryId, journalEntries.id))
          .innerJoin(chartOfAccounts, eq(journalLines.coaAccountId, chartOfAccounts.id))
          .where(and(...whereClauses))
          .orderBy(asc(journalEntries.postedAt), asc(journalEntries.id), asc(journalLines.id));

        type Line = {
          code: string;
          accountName: string;
          accountType: string;
          side: 'debit' | 'credit';
          amount: string;
        };
        type Entry = {
          id: string;
          postedAt: string;
          sourceEntityType: string;
          sourceEntityId: string;
          memo: string | null;
          lines: Line[];
        };

        const entries: Entry[] = [];
        const byEntry = new Map<string, Entry>();
        const tbByCode = new Map<
          string,
          { code: string; accountName: string; accountType: string; debit: number; credit: number }
        >();

        for (const r of rows) {
          let e = byEntry.get(r.entryId);
          if (!e) {
            e = {
              id: r.entryId,
              postedAt: r.postedAt.toISOString(),
              sourceEntityType: r.sourceEntityType,
              sourceEntityId: r.sourceEntityId,
              memo: r.memo,
              lines: [],
            };
            byEntry.set(r.entryId, e);
            entries.push(e);
          }
          e.lines.push({
            code: r.code,
            accountName: r.accountName,
            accountType: r.accountType,
            side: r.side as 'debit' | 'credit',
            amount: r.amount,
          });
          let tb = tbByCode.get(r.code);
          if (!tb) {
            tb = {
              code: r.code,
              accountName: r.accountName,
              accountType: r.accountType,
              debit: 0,
              credit: 0,
            };
            tbByCode.set(r.code, tb);
          }
          if (r.side === 'debit') tb.debit += Number(r.amount);
          else tb.credit += Number(r.amount);
        }

        const trialBalance = Array.from(tbByCode.values())
          .map((t) => ({
            code: t.code,
            accountName: t.accountName,
            accountType: t.accountType,
            debit: t.debit.toFixed(2),
            credit: t.credit.toFixed(2),
            net: (t.debit - t.credit).toFixed(2),
          }))
          .sort((a, b) => (a.code < b.code ? -1 : 1));

        if (format === 'csv') {
          const csvCell = (v: string | null) => {
            const s = v ?? '';
            return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
          };
          const header =
            'posted_at,entry_id,code,account_name,side,amount,source_type,source_id,memo';
          const lines = [header];
          for (const e of entries) {
            for (const l of e.lines) {
              lines.push(
                [
                  e.postedAt,
                  e.id,
                  l.code,
                  csvCell(l.accountName),
                  l.side,
                  l.amount,
                  e.sourceEntityType,
                  e.sourceEntityId,
                  csvCell(e.memo),
                ].join(','),
              );
            }
          }
          return c.body(`${lines.join('\n')}\n`, 200, {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': `attachment; filename="ledger-${company.name.replace(
              /[^a-z0-9-]/gi,
              '_',
            )}.csv"`,
          });
        }

        return c.json({
          companyId: company.id,
          companyName: company.name,
          from: fromRaw ?? null,
          to: toRaw ?? null,
          entries,
          trialBalance,
        });
      })
      // Position dashboard (slice 8.10). The product's answer surface: money
      // in, money out, what's owed — read straight off the ledger (the payoff
      // of the L1–L4 reshape). `money in/out` is cash movement over a window
      // (debits / credits on cash-like asset accounts — every asset except AR,
      // since an invoice being *sent* debits AR but that isn't cash in hand);
      // `owed` is the live AR balance, point-in-time, not period-bound. Cash
      // basis, UTC window (a per-tenant timezone is a later refinement).
      .get(
        '/api/companies/:id/dashboard',
        validator('query', (v) => ({
          period: typeof v.period === 'string' ? v.period : undefined,
          from: typeof v.from === 'string' ? v.from : undefined,
          to: typeof v.to === 'string' ? v.to : undefined,
        })),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);

          const tx = c.get('tx');
          const accountId = c.get('accountId');

          const [company] = await tx
            .select({ id: companies.id })
            .from(companies)
            .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
            .limit(1);
          if (!company) return c.json({ error: 'company_not_found' }, 404);

          // Window for the in/out flows. Explicit from/to wins (L4-style, for
          // deterministic callers + tests); otherwise a named period, default
          // this month. Upper bound is half-open on the day after `to` so the
          // last day is fully included (matches the ledger export).
          const { period: periodRaw, from: fromRaw, to: toRaw } = c.req.valid('query');
          const period = periodRaw ?? 'month';
          let fromDate: Date;
          let toExclusive: Date;
          if (fromRaw !== undefined || toRaw !== undefined) {
            const f = fromRaw ? new Date(`${fromRaw}T00:00:00Z`) : null;
            const t = toRaw ? new Date(`${toRaw}T00:00:00Z`) : null;
            if (!f || Number.isNaN(f.getTime())) return c.json({ error: 'invalid_from' }, 400);
            if (!t || Number.isNaN(t.getTime())) return c.json({ error: 'invalid_to' }, 400);
            if (f > t) return c.json({ error: 'invalid_range' }, 400);
            fromDate = f;
            toExclusive = new Date(t);
            toExclusive.setUTCDate(toExclusive.getUTCDate() + 1);
          } else {
            const now = new Date();
            const y = now.getUTCFullYear();
            const m = now.getUTCMonth();
            const d = now.getUTCDate();
            toExclusive = new Date(Date.UTC(y, m, d + 1));
            if (period === 'month') {
              fromDate = new Date(Date.UTC(y, m, 1));
            } else if (period === '30d') {
              fromDate = new Date(Date.UTC(y, m, d - 29));
            } else if (period === 'ytd') {
              fromDate = new Date(Date.UTC(y, 0, 1));
            } else {
              return c.json({ error: 'invalid_period' }, 400);
            }
          }

          // Reversal-safe cash flow + live AR balance (shared with cash-flow
          // nudges) — see cashFlowNet / arBalance in lib/ledger.ts. Netting per
          // source means expense edits/voids don't inflate the flows (#144).
          const cash = await cashFlowNet(tx, { accountId, companyId: id, fromDate, toExclusive });
          const owed = await arBalance(tx, { accountId, companyId: id });

          // Inclusive display window (the day before the half-open upper bound).
          const toInclusive = new Date(toExclusive);
          toInclusive.setUTCDate(toInclusive.getUTCDate() - 1);
          const ymd = (dt: Date) => dt.toISOString().slice(0, 10);

          return c.json({
            moneyIn: cash.moneyIn,
            moneyOut: cash.moneyOut,
            owed,
            from: ymd(fromDate),
            to: ymd(toInclusive),
          });
        },
      )
      // Cash-flow nudges (AI insight). Deterministic ledger signals computed
      // here (the LLM never does ledger arithmetic); the reasoning-model
      // advisor only narrates them into <=3 plain-English nudges. Cached on the
      // company row + regenerated only when the signals' hash changes (new
      // activity, a newly-overdue invoice, a month rollover) — so a quiet
      // dashboard reload returns the cached text with no model call. Opt-in
      // like the other AI routes: 503 only when there's no advisor AND nothing
      // cached. The cache write on a GET is deliberate read-through memoisation.
      .get('/api/companies/:id/cash-flow-nudges', async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);

        const tx = c.get('tx');
        const accountId = c.get('accountId');

        const [company] = await tx
          .select({
            id: companies.id,
            cachedNudges: companies.cashFlowNudges,
            cachedHash: companies.nudgesInputHash,
            generatedAt: companies.nudgesGeneratedAt,
          })
          .from(companies)
          .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
          .limit(1);
        if (!company) return c.json({ error: 'company_not_found' }, 404);

        // Window math (UTC, half-open upper bounds). MTD = month start → tomorrow;
        // trailing = the 3 prior full calendar months (Date.UTC handles year
        // underflow). overdue = sent invoices whose due date has passed.
        const now = new Date();
        const y = now.getUTCFullYear();
        const m = now.getUTCMonth();
        const d = now.getUTCDate();
        const todayYmd = now.toISOString().slice(0, 10);
        const monthStart = new Date(Date.UTC(y, m, 1));
        const tomorrow = new Date(Date.UTC(y, m, d + 1));

        const scope = { accountId, companyId: id };
        const monthToDate = await cashFlowNet(tx, {
          ...scope,
          fromDate: monthStart,
          toExclusive: tomorrow,
        });
        const trailingMonths: CashFlowSignals['trailingMonths'] = [];
        for (let k = 3; k >= 1; k--) {
          const start = new Date(Date.UTC(y, m - k, 1));
          const end = new Date(Date.UTC(y, m - k + 1, 1));
          const flow = await cashFlowNet(tx, { ...scope, fromDate: start, toExclusive: end });
          trailingMonths.push({
            month: start.toISOString().slice(0, 7),
            moneyIn: flow.moneyIn,
            moneyOut: flow.moneyOut,
          });
        }
        const [overdue] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(invoices)
          .where(
            and(
              eq(invoices.accountId, accountId),
              eq(invoices.companyId, id),
              eq(invoices.status, 'sent'),
              lt(invoices.dueDate, todayYmd),
            ),
          );

        const signals: CashFlowSignals = {
          asOf: todayYmd,
          cashOnHand: await cashOnHand(tx, scope),
          monthToDate,
          trailingMonths,
          owed: await arBalance(tx, scope),
          overdueCount: overdue?.count ?? 0,
        };
        // Version-tag the cache key so a prompt/advisor change (CASH_FLOW_NUDGE_VERSION)
        // regenerates cached nudges — the signals hash alone wouldn't change.
        const hash = createHash('sha256')
          .update(JSON.stringify({ v: CASH_FLOW_NUDGE_VERSION, signals }))
          .digest('hex');

        // Cache hit: signals unchanged since the last generation → no model call.
        if (company.cachedNudges && company.cachedHash === hash) {
          return c.json({
            nudges: company.cachedNudges,
            generatedAt: company.generatedAt?.toISOString() ?? null,
          });
        }

        // No advisor configured: serve stale cache if we have it, else 503.
        if (!deps.advisor) {
          if (company.cachedNudges) {
            return c.json({
              nudges: company.cachedNudges,
              generatedAt: company.generatedAt?.toISOString() ?? null,
            });
          }
          return c.json({ error: 'ai_not_configured' }, 503);
        }

        // Cache miss: regenerate, persist, return. A model failure leaves the
        // old cache intact and surfaces 502 (the streamed UI shows nothing).
        let nudges: Awaited<ReturnType<CashFlowAdvisor['advise']>>;
        try {
          nudges = await deps.advisor.advise(signals);
        } catch (_err) {
          return c.json({ error: 'nudges_failed' }, 502);
        }
        const generatedAt = new Date();
        await tx
          .update(companies)
          .set({ cashFlowNudges: nudges, nudgesInputHash: hash, nudgesGeneratedAt: generatedAt })
          .where(and(eq(companies.id, id), eq(companies.accountId, accountId)));

        return c.json({ nudges, generatedAt: generatedAt.toISOString() });
      })
      // Anomaly flagging (AI-layer insight, deterministic): unusual spending vs
      // the customer's own history. Computed straight from the expenses table
      // (edits update the row in place, deletes set deleted_at — so summing
      // `amount` where deleted_at is null is the correct current total, no
      // ledger-reversal handling needed). Rolling windows avoid the partial-
      // calendar-month trap: `recent` = last 30 days; `baseline` = the 90 days
      // before that, averaged to a per-30-day figure ("your typical month").
      // Flags overall spend and per-category spikes; the % + a min-dollar floor
      // suppress noise on tiny categories. No LLM — the numbers are the insight.
      .get('/api/companies/:id/spending-anomalies', async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        const tx = c.get('tx');
        const accountId = c.get('accountId');

        const [company] = await tx
          .select({ id: companies.id })
          .from(companies)
          .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
          .limit(1);
        if (!company) return c.json({ error: 'company_not_found' }, 404);

        // Window boundaries as YYYY-MM-DD (ISO strings sort chronologically, so
        // string comparison on the bare `expense_date` column is correct).
        const now = new Date();
        const dayMs = 86_400_000;
        const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
        const today = ymd(now.getTime());
        const recentStart = ymd(now.getTime() - 29 * dayMs); // last 30 days incl. today
        const baselineEnd = ymd(now.getTime() - 30 * dayMs); // day before the recent window
        const baselineStart = ymd(now.getTime() - 119 * dayMs); // 90 days before that

        const rows = await tx
          .select({
            code: chartOfAccounts.code,
            name: chartOfAccounts.name,
            recent: sql<string>`coalesce(sum(${expenses.amount}) filter (where ${expenses.expenseDate} >= ${recentStart}), 0)`,
            baseline: sql<string>`coalesce(sum(${expenses.amount}) filter (where ${expenses.expenseDate} <= ${baselineEnd}), 0)`,
          })
          .from(expenses)
          .innerJoin(chartOfAccounts, eq(expenses.categoryAccountId, chartOfAccounts.id))
          .where(
            and(
              eq(expenses.accountId, accountId),
              eq(expenses.companyId, id),
              isNull(expenses.deletedAt),
              gte(expenses.expenseDate, baselineStart),
              lte(expenses.expenseDate, today),
            ),
          )
          .groupBy(chartOfAccounts.id, chartOfAccounts.code, chartOfAccounts.name);

        // Thresholds: overall flags at +40% over the typical month; a category
        // needs +50% AND at least $50 of recent spend so a tiny line doesn't
        // shout. baseline is divided by 3 (three 30-day windows) to a per-month
        // average.
        const OVERALL_OVER = 0.4;
        const CATEGORY_OVER = 0.5;
        const CATEGORY_MIN_RECENT = 50;

        let recentTotal = 0;
        let baselineTotal = 0;
        const categories: {
          code: string;
          name: string;
          recent: string;
          typical: string;
          pctOver: number;
        }[] = [];
        for (const r of rows) {
          const recent = Number(r.recent);
          const typical = Number(r.baseline) / 3;
          recentTotal += recent;
          baselineTotal += Number(r.baseline);
          if (
            typical > 0 &&
            recent >= typical * (1 + CATEGORY_OVER) &&
            recent >= CATEGORY_MIN_RECENT
          ) {
            categories.push({
              code: r.code,
              name: r.name,
              recent: recent.toFixed(2),
              typical: typical.toFixed(2),
              pctOver: Math.round((recent / typical - 1) * 100),
            });
          }
        }
        categories.sort((a, b) => b.pctOver - a.pctOver);

        const typicalTotal = baselineTotal / 3;
        const enoughHistory = baselineTotal > 0;
        const overall =
          enoughHistory && recentTotal >= typicalTotal * (1 + OVERALL_OVER)
            ? {
                recent: recentTotal.toFixed(2),
                typical: typicalTotal.toFixed(2),
                pctOver: Math.round((recentTotal / typicalTotal - 1) * 100),
              }
            : null;

        return c.json({ enoughHistory, overall, categories: categories.slice(0, 5) });
      })
      // Read the company's chart of accounts. Powers the expense form's
      // category (type=expense) + payment (type=asset) comboboxes (slice
      // 8.9e) and the expense list's category filter (8.9d). Active rows
      // only, ordered by code so the UI renders them in the standard COA
      // sequence (assets → … → expenses, Schedule C order within 6000–7950).
      // Optional ?type= narrows to one account_type; unknown values just
      // return an empty set.
      .get(
        '/api/companies/:id/accounts',
        // Query validator so the typed hc<AppType>() client can pass
        // `{ query: { type } }` — a path-param route types its Input as
        // `{ param }` and rejects an untyped query without this (same reason
        // the PATCH endpoints carry a json validator).
        validator('query', (v) => ({
          type: typeof v.type === 'string' ? v.type : undefined,
        })),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);

          const tx = c.get('tx');
          const accountId = c.get('accountId');

          const [company] = await tx
            .select({ id: companies.id })
            .from(companies)
            .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
            .limit(1);
          if (!company) return c.json({ error: 'company_not_found' }, 404);

          const { type } = c.req.valid('query');
          const conditions = [
            eq(chartOfAccounts.accountId, accountId),
            eq(chartOfAccounts.companyId, id),
            eq(chartOfAccounts.isActive, true),
          ];
          if (type) conditions.push(eq(chartOfAccounts.accountType, type));

          const accounts = await tx
            .select({
              id: chartOfAccounts.id,
              code: chartOfAccounts.code,
              name: chartOfAccounts.name,
              accountType: chartOfAccounts.accountType,
              normalBalance: chartOfAccounts.normalBalance,
            })
            .from(chartOfAccounts)
            .where(and(...conditions))
            .orderBy(asc(chartOfAccounts.code));

          return c.json({ accounts });
        },
      )
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
      // Late-payer detection (AI-layer "invoice intelligence", deterministic):
      // payment reliability computed from this customer's invoice history. "Late"
      // = paid after the due date; avgDaysLate is signed (negative = typically
      // early). overdue* count invoices still unpaid past due. One aggregate
      // pass; no LLM — the numbers are the insight. The customer page renders a
      // plain-English line from these and decides the "enough history" floor.
      .get('/api/customers/:id/payment-reliability', async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        const tx = c.get('tx');
        const accountId = c.get('accountId');

        const [customer] = await tx
          .select({ id: customers.id })
          .from(customers)
          .where(and(eq(customers.id, id), eq(customers.accountId, accountId)))
          .limit(1);
        if (!customer) return c.json({ error: 'customer_not_found' }, 404);

        const todayYmd = new Date().toISOString().slice(0, 10);
        const [stats] = await tx
          .select({
            paidCount: sql<number>`count(*) filter (where ${invoices.paidAt} is not null)::int`,
            lateCount: sql<number>`count(*) filter (where ${invoices.paidAt} is not null and (${invoices.paidAt} at time zone 'UTC')::date > ${invoices.dueDate})::int`,
            // Average days past due over the LATE invoices only ("when late,
            // about N days late"). Averaging over all paid invoices would let a
            // far-out due date swing it wildly; this stays the intuitive figure
            // and is always >= 1. Null when nothing was paid late.
            avgDaysLate: sql<
              number | null
            >`round(avg((${invoices.paidAt} at time zone 'UTC')::date - ${invoices.dueDate}) filter (where ${invoices.paidAt} is not null and (${invoices.paidAt} at time zone 'UTC')::date > ${invoices.dueDate}))::int`,
            overdueCount: sql<number>`count(*) filter (where ${invoices.status} = 'sent' and ${invoices.dueDate} < ${todayYmd})::int`,
            overdueTotal: sql<string>`coalesce(sum(${invoices.total}) filter (where ${invoices.status} = 'sent' and ${invoices.dueDate} < ${todayYmd}), 0)::numeric(15,2)`,
          })
          .from(invoices)
          .where(and(eq(invoices.accountId, accountId), eq(invoices.customerId, id)));

        const paidCount = stats?.paidCount ?? 0;
        const lateCount = stats?.lateCount ?? 0;
        return c.json({
          paidCount,
          lateCount,
          onTimeCount: paidCount - lateCount,
          latePct: paidCount > 0 ? Math.round((lateCount / paidCount) * 100) : null,
          avgDaysLate: stats?.avgDaysLate ?? null,
          overdueCount: stats?.overdueCount ?? 0,
          overdueTotal: stats?.overdueTotal ?? '0.00',
        });
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
      // Duplicate-as-template: clone any invoice into a fresh draft to reuse as
      // a starting point. Copies customer + line items + header amounts/notes;
      // gives it a new number and today/Net-30 dates; status, stamps, and the
      // public token are deliberately NOT copied (it starts clean at draft, no
      // ledger posting until mark-sent). Unlike estimate→invoice convert this is
      // intentionally repeatable — no idempotency link. Any source status is a
      // valid template (draft/sent/paid/voided).
      .post('/api/invoices/:id/duplicate', async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        const tx = c.get('tx');
        const accountId = c.get('accountId');

        const [source] = await tx
          .select()
          .from(invoices)
          .where(and(eq(invoices.id, id), eq(invoices.accountId, accountId)))
          .limit(1);
        if (!source) return c.json({ error: 'invoice_not_found' }, 404);

        const sourceLines = await tx
          .select()
          .from(invoiceLineItems)
          .where(and(eq(invoiceLineItems.invoiceId, id), eq(invoiceLineItems.accountId, accountId)))
          .orderBy(asc(invoiceLineItems.position));

        const today = new Date();
        const todayIso = today.toISOString().slice(0, 10);
        const dueIso = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10);

        const [latest] = await tx
          .select({ number: invoices.number })
          .from(invoices)
          .where(and(eq(invoices.accountId, accountId), eq(invoices.companyId, source.companyId)))
          .orderBy(desc(invoices.createdAt))
          .limit(1);
        const number = suggestNextInvoiceNumber(latest?.number);

        const [taken] = await tx
          .select({ id: invoices.id })
          .from(invoices)
          .where(
            and(
              eq(invoices.accountId, accountId),
              eq(invoices.companyId, source.companyId),
              eq(invoices.number, number),
            ),
          )
          .limit(1);
        if (taken) return c.json({ error: 'invoice_number_collision', number }, 409);

        const invoiceId = uuidv7();
        await tx.insert(invoices).values({
          id: invoiceId,
          accountId,
          companyId: source.companyId,
          customerId: source.customerId,
          number,
          issueDate: todayIso,
          dueDate: dueIso,
          currency: source.currency,
          subtotal: source.subtotal,
          tax: source.tax,
          total: source.total,
          notes: source.notes,
        });
        if (sourceLines.length > 0) {
          await tx.insert(invoiceLineItems).values(
            sourceLines.map((li) => ({
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

        await c.var.audit({
          entityType: 'invoice',
          entityId: invoiceId,
          action: 'create',
          after: {
            id: invoiceId,
            companyId: source.companyId,
            customerId: source.customerId,
            number,
            issueDate: todayIso,
            dueDate: dueIso,
            currency: source.currency,
            subtotal: source.subtotal,
            tax: source.tax,
            total: source.total,
            notes: source.notes,
            duplicatedFromInvoiceId: id,
          },
          companyId: source.companyId,
        });

        return c.json({ id: invoiceId }, 201);
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
      // mark-paid carries a JSON body recording how the money arrived. The
      // validator middleware is required so hc<AppType>() sees `json` on the
      // typed Input (per the path-param POST-with-body footgun).
      .post(
        '/api/invoices/:id/mark-paid',
        validator('json', (value, c) => {
          const parsed = invoiceMarkPaidSchema.safeParse(value);
          if (!parsed.success) {
            return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
          }
          return parsed.data;
        }),
        (c) => {
          const data = c.req.valid('json');
          return transitionInvoice(
            c,
            c.req.param('id'),
            'mark-paid',
            INVOICE_TRANSITIONS['mark-paid'],
            {
              patch: { paymentMethod: data.method, paymentReference: data.reference ?? null },
              // Backdated payment date drives paidAt + the ledger posting date;
              // omitted → now (the quick caret-menu path).
              effectiveAt: data.paidOn ? new Date(data.paidOn) : undefined,
            },
          );
        },
      )
      .post('/api/invoices/:id/void', (c) =>
        transitionInvoice(c, c.req.param('id'), 'void', INVOICE_TRANSITIONS.void),
      )
      // Edit the recorded payment on an already-paid invoice. Method/reference
      // are plain column updates. A changed payment date is an append-only
      // ledger correction (journal tables are insert-only, migration 0026):
      // reverse the original paid posting at its old date and re-post at the
      // new one via repostInvoicePaymentDate, so the cash moves to the right
      // reporting period. Only valid while status === 'paid'.
      .post(
        '/api/invoices/:id/edit-payment',
        validator('json', (value, c) => {
          const parsed = invoiceMarkPaidSchema.safeParse(value);
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

          const [current] = await tx
            .select()
            .from(invoices)
            .where(and(eq(invoices.id, id), eq(invoices.accountId, accountId)))
            .limit(1);
          if (!current) return c.json({ error: 'invoice_not_found' }, 404);
          if (current.status !== 'paid') {
            return c.json({ error: 'not_paid', status: current.status }, 409);
          }

          const now = new Date();
          // paidAt is a timestamp; the wire value is YYYY-MM-DD — compare date
          // portions to decide whether the ledger needs a date correction.
          const oldDate = current.paidAt ? current.paidAt.toISOString().slice(0, 10) : null;
          if (data.paidOn && current.paidAt && data.paidOn !== oldDate) {
            await repostInvoicePaymentDate(tx, {
              invoice: current,
              prevStatus: current.sentAt ? 'sent' : 'draft',
              accountId,
              companyId: current.companyId,
              fromDate: current.paidAt,
              toDate: new Date(data.paidOn),
            });
          }

          const patch: Record<string, unknown> = {
            updatedAt: now,
            paymentMethod: data.method,
            paymentReference: data.reference ?? null,
          };
          if (data.paidOn) patch.paidAt = new Date(data.paidOn);

          const [updated] = await tx
            .update(invoices)
            .set(patch)
            .where(and(eq(invoices.id, id), eq(invoices.accountId, accountId)))
            .returning();
          if (!updated) return c.json({ error: 'invoice_not_found' }, 404);

          await c.var.audit({
            entityType: 'invoice',
            entityId: id,
            action: 'edit-payment',
            before: {
              paidAt: current.paidAt,
              paymentMethod: current.paymentMethod,
              paymentReference: current.paymentReference,
            },
            after: {
              paidAt: updated.paidAt,
              paymentMethod: updated.paymentMethod,
              paymentReference: updated.paymentReference,
            },
            companyId: updated.companyId,
          });

          return c.json(updated);
        },
      )
      // Recurring invoice schedules (slice R2). A schedule is a template +
      // cadence; the background sweeper (slice R3) clones it into a real
      // invoice on each occurrence. CRUD + pause/resume/end here; no
      // generation yet. Mirrors the invoice routes (customer↔company
      // invariant, full-replacement line items, draft-style PATCH) minus the
      // (company_id, number) uniqueness — schedules have no number.
      .post('/api/recurring-invoices', async (c) => {
        const body = await c.req.json().catch(() => null);
        const parsed = recurringInvoiceCreateSchema.safeParse(body);
        if (!parsed.success) {
          return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
        }

        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const { companyId, customerId, lineItems } = parsed.data;
        const d = parsed.data;

        const [customer] = await tx
          .select({ id: customers.id, companyId: customers.companyId })
          .from(customers)
          .where(and(eq(customers.id, customerId), eq(customers.accountId, accountId)))
          .limit(1);
        if (!customer) return c.json({ error: 'customer_not_found' }, 404);
        if (customer.companyId !== companyId) {
          return c.json({ error: 'customer_company_mismatch' }, 400);
        }

        const recurringId = uuidv7();
        // next_run_date seeds from start_date; the sweeper advances it.
        await tx.insert(recurringInvoices).values({
          id: recurringId,
          accountId,
          companyId,
          customerId,
          frequency: d.frequency,
          intervalCount: d.intervalCount,
          startDate: d.startDate,
          nextRunDate: d.startDate,
          endDate: d.endDate ?? null,
          maxOccurrences: d.maxOccurrences ?? null,
          netTermsDays: d.netTermsDays ?? 30,
          currency: d.currency ?? 'USD',
          subtotal: d.subtotal,
          tax: d.tax ?? '0',
          total: d.total,
          notes: d.notes ?? null,
        });
        const lineRows = lineItems.map((li) => ({
          id: uuidv7(),
          accountId,
          recurringInvoiceId: recurringId,
          ...li,
        }));
        await tx.insert(recurringInvoiceLineItems).values(lineRows);

        await c.var.audit({
          entityType: 'recurring_invoice',
          entityId: recurringId,
          action: 'create',
          after: { id: recurringId, ...parsed.data },
          companyId,
        });

        return c.json({ id: recurringId, ...parsed.data }, 201);
      })
      .get('/api/recurring-invoices', async (c) => {
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const companyId = c.req.query('companyId');
        const status = c.req.query('status');
        const conditions = [eq(recurringInvoices.accountId, accountId)];
        if (companyId) conditions.push(eq(recurringInvoices.companyId, companyId));
        if (status) conditions.push(eq(recurringInvoices.status, status));
        const rows = await tx
          .select()
          .from(recurringInvoices)
          .where(and(...conditions))
          .orderBy(asc(recurringInvoices.createdAt));
        return c.json({ recurringInvoices: rows });
      })
      .get('/api/recurring-invoices/:id', async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const [schedule] = await tx
          .select()
          .from(recurringInvoices)
          .where(and(eq(recurringInvoices.id, id), eq(recurringInvoices.accountId, accountId)));
        if (!schedule) return c.json({ error: 'recurring_invoice_not_found' }, 404);
        const lines = await tx
          .select()
          .from(recurringInvoiceLineItems)
          .where(
            and(
              eq(recurringInvoiceLineItems.recurringInvoiceId, id),
              eq(recurringInvoiceLineItems.accountId, accountId),
            ),
          )
          .orderBy(asc(recurringInvoiceLineItems.position));
        // Generated invoices carry recurring_invoice_id provenance (slice R1).
        // Return them so the detail page can show the run history without a
        // second round-trip; newest first.
        const generatedInvoices = await tx
          .select({
            id: invoices.id,
            number: invoices.number,
            status: invoices.status,
            issueDate: invoices.issueDate,
            total: invoices.total,
            createdAt: invoices.createdAt,
          })
          .from(invoices)
          .where(and(eq(invoices.recurringInvoiceId, id), eq(invoices.accountId, accountId)))
          .orderBy(desc(invoices.createdAt));
        return c.json({ ...schedule, lineItems: lines, generatedInvoices });
      })
      .patch(
        '/api/recurring-invoices/:id',
        validator('json', (value, c) => {
          const parsed = recurringInvoiceUpdateSchema.safeParse(value);
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
          const { customerId, lineItems } = data;
          const d = data;

          const [current] = await tx
            .select()
            .from(recurringInvoices)
            .where(and(eq(recurringInvoices.id, id), eq(recurringInvoices.accountId, accountId)))
            .limit(1);
          if (!current) return c.json({ error: 'recurring_invoice_not_found' }, 404);

          // Edits are blocked once a schedule is ended (terminal — its run
          // history is fixed). active + paused schedules stay editable so the
          // operator can adjust the template, cadence, or customer.
          if (current.status === 'ended') {
            return c.json({ error: 'not_editable', status: current.status }, 409);
          }

          // customerId is mutable; companyId is fixed (omitted from the update
          // schema), so the customer↔company invariant compares against
          // current.companyId.
          const [customer] = await tx
            .select({ id: customers.id, companyId: customers.companyId })
            .from(customers)
            .where(and(eq(customers.id, customerId), eq(customers.accountId, accountId)))
            .limit(1);
          if (!customer) return c.json({ error: 'customer_not_found' }, 404);
          if (customer.companyId !== current.companyId) {
            return c.json({ error: 'customer_company_mismatch' }, 400);
          }

          const beforeLines = await tx
            .select()
            .from(recurringInvoiceLineItems)
            .where(
              and(
                eq(recurringInvoiceLineItems.recurringInvoiceId, id),
                eq(recurringInvoiceLineItems.accountId, accountId),
              ),
            )
            .orderBy(asc(recurringInvoiceLineItems.position));

          await tx
            .delete(recurringInvoiceLineItems)
            .where(
              and(
                eq(recurringInvoiceLineItems.recurringInvoiceId, id),
                eq(recurringInvoiceLineItems.accountId, accountId),
              ),
            );
          const newLineRows = lineItems.map((li) => ({
            id: uuidv7(),
            accountId,
            recurringInvoiceId: id,
            ...li,
          }));
          await tx.insert(recurringInvoiceLineItems).values(newLineRows);

          // next_run_date and occurrence_count are runtime state owned by the
          // sweeper, not template fields — PATCH leaves them alone EXCEPT
          // before the first generation (occurrence_count === 0), where we
          // keep next_run_date pinned to start_date so editing the start date
          // of a not-yet-run schedule behaves intuitively.
          const nextRunPatch = current.occurrenceCount === 0 ? { nextRunDate: d.startDate } : {};

          const [updated] = await tx
            .update(recurringInvoices)
            .set({
              customerId,
              frequency: d.frequency,
              intervalCount: d.intervalCount,
              startDate: d.startDate,
              endDate: d.endDate ?? null,
              maxOccurrences: d.maxOccurrences ?? null,
              netTermsDays: d.netTermsDays ?? 30,
              currency: d.currency ?? current.currency,
              subtotal: d.subtotal,
              tax: d.tax ?? '0',
              total: d.total,
              notes: d.notes ?? null,
              updatedAt: new Date(),
              ...nextRunPatch,
            })
            .where(and(eq(recurringInvoices.id, id), eq(recurringInvoices.accountId, accountId)))
            .returning();
          if (!updated) return c.json({ error: 'recurring_invoice_not_found' }, 404);

          await c.var.audit({
            entityType: 'recurring_invoice',
            entityId: id,
            action: 'update',
            before: { ...current, lineItems: beforeLines },
            after: { ...updated, lineItems: newLineRows },
            companyId: current.companyId,
          });

          return c.json({ ...updated, lineItems: newLineRows });
        },
      )
      .post('/api/recurring-invoices/:id/pause', (c) =>
        transitionRecurringInvoice(c, c.req.param('id'), 'pause'),
      )
      .post('/api/recurring-invoices/:id/resume', (c) =>
        transitionRecurringInvoice(c, c.req.param('id'), 'resume'),
      )
      .post('/api/recurring-invoices/:id/end', (c) =>
        transitionRecurringInvoice(c, c.req.param('id'), 'end'),
      )
      // Generate the next occurrence right now (manual trigger). Same engine
      // the pg-boss sweeper runs, but in the request's tenant tx and attributed
      // to the requesting user rather than the system user. Doubles as the test
      // path (no waiting for cron) and a "send the next one now" UX action.
      // Only an active schedule can run — paused/ended return 409.
      .post('/api/recurring-invoices/:id/run-now', async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const [schedule] = await tx
          .select()
          .from(recurringInvoices)
          .where(and(eq(recurringInvoices.id, id), eq(recurringInvoices.accountId, accountId)))
          .limit(1);
        if (!schedule) return c.json({ error: 'recurring_invoice_not_found' }, 404);
        if (schedule.status !== 'active') {
          return c.json({ error: 'invalid_transition', from: schedule.status, to: 'run' }, 409);
        }
        const result = await generateOnce(tx, {
          schedule,
          audit: c.var.audit,
          mail: {
            mailer: deps.mailer,
            emailFrom: deps.emailFrom,
            publicAppUrl: deps.publicAppUrl,
          },
        });
        return c.json(result, 201);
      })
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
      // Duplicate-as-template (mirrors the invoice route): clone any estimate
      // into a fresh draft. Copies customer + line items + amounts/notes; new
      // number, today issue date + Net-30 expiry; status, send/accept/decline
      // stamps, public token, and the converted-invoice link are all reset
      // (clean draft). Repeatable — no idempotency link.
      .post('/api/estimates/:id/duplicate', async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        const tx = c.get('tx');
        const accountId = c.get('accountId');

        const [source] = await tx
          .select()
          .from(estimates)
          .where(and(eq(estimates.id, id), eq(estimates.accountId, accountId)))
          .limit(1);
        if (!source) return c.json({ error: 'estimate_not_found' }, 404);

        const sourceLines = await tx
          .select()
          .from(estimateLineItems)
          .where(
            and(eq(estimateLineItems.estimateId, id), eq(estimateLineItems.accountId, accountId)),
          )
          .orderBy(asc(estimateLineItems.position));

        const today = new Date();
        const todayIso = today.toISOString().slice(0, 10);
        const expiresIso = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10);

        const [latest] = await tx
          .select({ number: estimates.number })
          .from(estimates)
          .where(and(eq(estimates.accountId, accountId), eq(estimates.companyId, source.companyId)))
          .orderBy(desc(estimates.createdAt))
          .limit(1);
        const number = suggestNextEstimateNumber(latest?.number);

        const [taken] = await tx
          .select({ id: estimates.id })
          .from(estimates)
          .where(
            and(
              eq(estimates.accountId, accountId),
              eq(estimates.companyId, source.companyId),
              eq(estimates.number, number),
            ),
          )
          .limit(1);
        if (taken) return c.json({ error: 'estimate_number_collision', number }, 409);

        const estimateId = uuidv7();
        await tx.insert(estimates).values({
          id: estimateId,
          accountId,
          companyId: source.companyId,
          customerId: source.customerId,
          number,
          issueDate: todayIso,
          expiresOn: expiresIso,
          currency: source.currency,
          subtotal: source.subtotal,
          tax: source.tax,
          total: source.total,
          notes: source.notes,
        });
        if (sourceLines.length > 0) {
          await tx.insert(estimateLineItems).values(
            sourceLines.map((li) => ({
              id: uuidv7(),
              accountId,
              estimateId,
              position: li.position,
              description: li.description,
              quantity: li.quantity,
              unitPrice: li.unitPrice,
              amount: li.amount,
            })),
          );
        }

        await c.var.audit({
          entityType: 'estimate',
          entityId: estimateId,
          action: 'create',
          after: {
            id: estimateId,
            companyId: source.companyId,
            customerId: source.customerId,
            number,
            issueDate: todayIso,
            expiresOn: expiresIso,
            currency: source.currency,
            subtotal: source.subtotal,
            tax: source.tax,
            total: source.total,
            notes: source.notes,
            duplicatedFromEstimateId: id,
          },
          companyId: source.companyId,
        });

        return c.json({ id: estimateId }, 201);
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
      // ---- Expenses (slice 8.9c) ----------------------------------------
      // Third MVP entity chain, ledger-aware from day one. Every mutation
      // wraps the row write + audit row + journal posting in the same tenant
      // tx (c.get('tx')) so the deferred sum-to-zero trigger on journal_lines
      // fires at commit and a posting failure rolls the whole mutation back
      // together — the shape L2 established for invoice transitions. Create
      // posts Dr <category> / Cr <payment>; edit posts a reversal of the
      // prior entry + a fresh entry; delete is soft (deleted_at) and posts a
      // reversal only. category_account_id must be an 'expense' COA row,
      // payment_account_id an 'asset' row (the FK columns alone admit any
      // account, so the API type-checks before posting).
      .post('/api/expenses', async (c) => {
        const body = await c.req.json().catch(() => null);
        const parsed = expenseCreateSchema.safeParse(body);
        if (!parsed.success) {
          return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
        }

        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const { companyId, customerId, categoryAccountId, paymentAccountId, ...rest } = parsed.data;

        const [company] = await tx
          .select({ id: companies.id })
          .from(companies)
          .where(and(eq(companies.id, companyId), eq(companies.accountId, accountId)))
          .limit(1);
        if (!company) return c.json({ error: 'company_not_found' }, 404);

        // customerId is optional (carried for v1.x job-costing, not surfaced
        // in MVP). When present it must belong to this account AND match the
        // expense's company — the same invariant the invoice create enforces.
        if (customerId) {
          const [customer] = await tx
            .select({ id: customers.id, companyId: customers.companyId })
            .from(customers)
            .where(and(eq(customers.id, customerId), eq(customers.accountId, accountId)))
            .limit(1);
          if (!customer) return c.json({ error: 'customer_not_found' }, 404);
          if (customer.companyId !== companyId) {
            return c.json({ error: 'customer_company_mismatch' }, 400);
          }
        }

        const coa = await resolveCoaAccounts(tx, accountId, companyId, [
          categoryAccountId,
          paymentAccountId,
        ]);
        const category = coa.get(categoryAccountId);
        const payment = coa.get(paymentAccountId);
        if (!category || category.accountType !== 'expense') {
          return c.json({ error: 'invalid_category_account' }, 400);
        }
        if (!payment || payment.accountType !== 'asset') {
          return c.json({ error: 'invalid_payment_account' }, 400);
        }

        const expenseId = uuidv7();
        const [created] = await tx
          .insert(expenses)
          .values({
            id: expenseId,
            accountId,
            companyId,
            customerId: customerId ?? null,
            categoryAccountId,
            paymentAccountId,
            amount: rest.amount,
            expenseDate: rest.expenseDate,
            merchant: rest.merchant,
            memo: rest.memo ?? null,
          })
          .returning();

        await c.var.audit({
          entityType: 'expense',
          entityId: expenseId,
          action: 'create',
          after: created,
          companyId,
        });

        await postExpenseCreate(tx, {
          expense: { id: expenseId, merchant: rest.merchant, amount: rest.amount },
          categoryCode: category.code,
          paymentCode: payment.code,
          accountId,
          companyId,
          postedAt: expenseDateToPostedAt(rest.expenseDate),
        });

        return c.json(created, 201);
      })
      // ---- Text expense categorization (AI) -----------------------------
      // Stateless suggestion for the new/edit expense form: given the typed
      // merchant (+ optional memo/amount) the fast model picks a category from
      // the company's expense COA. The user reviews + saves — the AI never
      // writes the ledger. Opt-in like /extract: 503 when no LLM is configured.
      // A literal path, so it never collides with the /api/expenses/:id routes.
      .post('/api/expenses/categorize', async (c) => {
        const body = await c.req.json().catch(() => null);
        const parsed = expenseCategorizeSchema.safeParse(body);
        if (!parsed.success) {
          return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
        }
        if (!deps.categorizer) return c.json({ error: 'ai_not_configured' }, 503);

        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const { companyId, merchant, memo, amount } = parsed.data;

        const [company] = await tx
          .select({ id: companies.id })
          .from(companies)
          .where(and(eq(companies.id, companyId), eq(companies.accountId, accountId)))
          .limit(1);
        if (!company) return c.json({ error: 'company_not_found' }, 404);

        // The company's active expense COA — the model's suggestion is
        // constrained to these codes (in the prompt and by post-hoc validation
        // inside the categorizer) so it can't return a code that wouldn't post.
        const categories = await tx
          .select({
            id: chartOfAccounts.id,
            code: chartOfAccounts.code,
            name: chartOfAccounts.name,
          })
          .from(chartOfAccounts)
          .where(
            and(
              eq(chartOfAccounts.accountId, accountId),
              eq(chartOfAccounts.companyId, companyId),
              eq(chartOfAccounts.accountType, 'expense'),
              eq(chartOfAccounts.isActive, true),
            ),
          )
          .orderBy(asc(chartOfAccounts.code));

        let suggestedCategoryCode: string | null;
        try {
          ({ suggestedCategoryCode } = await deps.categorizer.categorize({
            merchant,
            memo: memo ?? null,
            amount: amount ?? null,
            allowedCategories: categories.map((row) => ({ code: row.code, name: row.name })),
          }));
        } catch (_err) {
          return c.json({ error: 'categorization_failed' }, 502);
        }

        // Resolve code → account id for the form prefill (the select is keyed by
        // id; codes are the stable persisted form). Null when nothing fit.
        const suggestedCategoryAccountId = suggestedCategoryCode
          ? (categories.find((row) => row.code === suggestedCategoryCode)?.id ?? null)
          : null;

        // Telemetry (opt-in; no-op unless the account enabled it). Same event
        // the receipt path emits — the AI did the categorisation work; the user
        // still confirms on save (TELEMETRY.md).
        if (suggestedCategoryCode) {
          await emit(tx, { name: 'expense_categorised', method: 'ai_suggested' });
        }

        return c.json({ suggestedCategoryCode, suggestedCategoryAccountId });
      })
      .get('/api/expenses', async (c) => {
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const companyId = c.req.query('companyId');
        const from = c.req.query('from');
        const to = c.req.query('to');
        const categoryAccountId = c.req.query('categoryAccountId');
        const q = c.req.query('q');

        // from/to are inclusive YYYY-MM-DD bounds on expense_date. Validate the
        // shape so a malformed value returns a clean 400 rather than letting
        // Postgres throw "invalid input syntax for type date" → 500.
        if (from !== undefined && !ISO_DATE_RE.test(from)) {
          return c.json({ error: 'invalid_from' }, 400);
        }
        if (to !== undefined && !ISO_DATE_RE.test(to)) {
          return c.json({ error: 'invalid_to' }, 400);
        }

        const conditions = [eq(expenses.accountId, accountId), isNull(expenses.deletedAt)];
        if (companyId) conditions.push(eq(expenses.companyId, companyId));
        if (from) conditions.push(gte(expenses.expenseDate, from));
        if (to) conditions.push(lte(expenses.expenseDate, to));
        if (categoryAccountId) conditions.push(eq(expenses.categoryAccountId, categoryAccountId));
        // Merchant contains-search. escapeLike neutralises %/_ so a literal
        // "50%" search doesn't turn into a wildcard.
        if (q) conditions.push(ilike(expenses.merchant, `%${escapeLike(q)}%`));

        const rows = await tx
          .select()
          .from(expenses)
          .where(and(...conditions))
          .orderBy(desc(expenses.expenseDate), desc(expenses.createdAt));
        return c.json({ expenses: rows });
      })
      .get('/api/expenses/:id', async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const [expense] = await tx
          .select()
          .from(expenses)
          .where(and(eq(expenses.id, id), eq(expenses.accountId, accountId)))
          .limit(1);
        if (!expense || expense.deletedAt) return c.json({ error: 'expense_not_found' }, 404);
        return c.json(expense);
      })
      .patch(
        '/api/expenses/:id',
        validator('json', (value, c) => {
          const parsed = expenseUpdateSchema.safeParse(value);
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

          const [current] = await tx
            .select()
            .from(expenses)
            .where(and(eq(expenses.id, id), eq(expenses.accountId, accountId)))
            .limit(1);
          if (!current || current.deletedAt) return c.json({ error: 'expense_not_found' }, 404);

          // Sparse merge: omitted fields keep their current value. companyId
          // is immutable (omitted from the schema) so the expense can't move
          // between companies and orphan its company-scoped ledger accounts.
          const next = {
            customerId: data.customerId !== undefined ? data.customerId : current.customerId,
            categoryAccountId: data.categoryAccountId ?? current.categoryAccountId,
            paymentAccountId: data.paymentAccountId ?? current.paymentAccountId,
            amount: data.amount ?? current.amount,
            expenseDate: data.expenseDate ?? current.expenseDate,
            merchant: data.merchant ?? current.merchant,
            memo: data.memo !== undefined ? data.memo : current.memo,
          };

          if (data.customerId !== undefined) {
            const [customer] = await tx
              .select({ id: customers.id, companyId: customers.companyId })
              .from(customers)
              .where(and(eq(customers.id, data.customerId), eq(customers.accountId, accountId)))
              .limit(1);
            if (!customer) return c.json({ error: 'customer_not_found' }, 404);
            if (customer.companyId !== current.companyId) {
              return c.json({ error: 'customer_company_mismatch' }, 400);
            }
          }

          // Resolve all four COA ids (old + new) in one round trip. The new
          // pair is type-checked like create; the old pair supplies the codes
          // for the reversal entry.
          const coa = await resolveCoaAccounts(tx, accountId, current.companyId, [
            current.categoryAccountId,
            current.paymentAccountId,
            next.categoryAccountId,
            next.paymentAccountId,
          ]);
          const newCategory = coa.get(next.categoryAccountId);
          const newPayment = coa.get(next.paymentAccountId);
          if (!newCategory || newCategory.accountType !== 'expense') {
            return c.json({ error: 'invalid_category_account' }, 400);
          }
          if (!newPayment || newPayment.accountType !== 'asset') {
            return c.json({ error: 'invalid_payment_account' }, 400);
          }
          const oldCategory = coa.get(current.categoryAccountId);
          const oldPayment = coa.get(current.paymentAccountId);
          if (!oldCategory || !oldPayment) {
            // ON DELETE RESTRICT keeps an in-use COA row alive, so a missing
            // stored account is an integrity failure, not a user error.
            throw new Error(`expense ${id}: stored COA accounts missing`);
          }

          const now = new Date();

          // Edit = reversal of the prior posting (old accounts/amount, old
          // period) + a fresh posting (new accounts/amount, new period). No
          // amend-in-place keeps the GL append-only; every edit nets to the
          // correct balance. (Locked decision: edit = reversal + new.)
          await postExpenseReversal(tx, {
            expense: { id, merchant: current.merchant, amount: current.amount },
            categoryCode: oldCategory.code,
            paymentCode: oldPayment.code,
            accountId,
            companyId: current.companyId,
            postedAt: expenseDateToPostedAt(current.expenseDate),
          });

          const [updated] = await tx
            .update(expenses)
            .set({
              customerId: next.customerId ?? null,
              categoryAccountId: next.categoryAccountId,
              paymentAccountId: next.paymentAccountId,
              amount: next.amount,
              expenseDate: next.expenseDate,
              merchant: next.merchant,
              memo: next.memo ?? null,
              updatedAt: now,
            })
            .where(and(eq(expenses.id, id), eq(expenses.accountId, accountId)))
            .returning();
          if (!updated) return c.json({ error: 'expense_not_found' }, 404);

          await c.var.audit({
            entityType: 'expense',
            entityId: id,
            action: 'update',
            before: current,
            after: updated,
            companyId: current.companyId,
          });

          await postExpenseCreate(tx, {
            expense: { id, merchant: next.merchant, amount: next.amount },
            categoryCode: newCategory.code,
            paymentCode: newPayment.code,
            accountId,
            companyId: current.companyId,
            postedAt: expenseDateToPostedAt(next.expenseDate),
          });

          return c.json(updated);
        },
      )
      .delete('/api/expenses/:id', async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        const tx = c.get('tx');
        const accountId = c.get('accountId');

        const [current] = await tx
          .select()
          .from(expenses)
          .where(and(eq(expenses.id, id), eq(expenses.accountId, accountId)))
          .limit(1);
        if (!current || current.deletedAt) return c.json({ error: 'expense_not_found' }, 404);

        const coa = await resolveCoaAccounts(tx, accountId, current.companyId, [
          current.categoryAccountId,
          current.paymentAccountId,
        ]);
        const category = coa.get(current.categoryAccountId);
        const payment = coa.get(current.paymentAccountId);
        if (!category || !payment) {
          throw new Error(`expense ${id}: stored COA accounts missing`);
        }

        const now = new Date();
        const [deleted] = await tx
          .update(expenses)
          .set({ deletedAt: now, updatedAt: now })
          .where(and(eq(expenses.id, id), eq(expenses.accountId, accountId)))
          .returning();
        if (!deleted) return c.json({ error: 'expense_not_found' }, 404);

        await c.var.audit({
          entityType: 'expense',
          entityId: id,
          action: 'delete',
          before: current,
          after: deleted,
          companyId: current.companyId,
        });

        // Soft delete keeps the row for history (deleted_at) but reverses the
        // original posting so the GL nets to zero for this expense.
        await postExpenseReversal(tx, {
          expense: { id, merchant: current.merchant, amount: current.amount },
          categoryCode: category.code,
          paymentCode: payment.code,
          accountId,
          companyId: current.companyId,
          postedAt: expenseDateToPostedAt(current.expenseDate),
        });

        return c.json(deleted);
      })
      // ---- Receipt capture (slice 8.9g) ---------------------------------
      // All-tier: the image is always saved (extraction in 8.9h is the gated
      // bit). Multipart upload, ≤10MB, jpeg/png/pdf. The object write is the
      // LAST await so a storage failure rolls back the column update + audit
      // together (rls-context rethrows c.error → tenant-tx rollback) — no
      // orphaned object, no dangling key. The tx is briefly held during the
      // upload, acceptable for occasional receipt-sized blobs. Audit rows
      // carry the storage key, never the bytes.
      .post('/api/expenses/:id/receipt', async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        if (!deps.storage) return c.json({ error: 'storage_not_configured' }, 503);

        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const [expense] = await tx
          .select()
          .from(expenses)
          .where(and(eq(expenses.id, id), eq(expenses.accountId, accountId)))
          .limit(1);
        if (!expense || expense.deletedAt) return c.json({ error: 'expense_not_found' }, 404);

        const body = await c.req.parseBody();
        const file = body.file;
        if (!(file instanceof File)) return c.json({ error: 'file_required' }, 400);
        const ext = RECEIPT_MIME_EXT[file.type];
        if (!ext) {
          return c.json(
            { error: 'unsupported_media_type', allowed: Object.keys(RECEIPT_MIME_EXT) },
            415,
          );
        }
        if (file.size > RECEIPT_MAX_BYTES) {
          return c.json({ error: 'file_too_large', maxBytes: RECEIPT_MAX_BYTES }, 413);
        }
        const bytes = new Uint8Array(await file.arrayBuffer());

        // Re-upload overwrites the column with a fresh key; the prior object is
        // left orphaned (rare, and harmless — keys are uuidv7 so no collision).
        const key = `accounts/${accountId}/companies/${expense.companyId}/expenses/${id}/${uuidv7()}.${ext}`;
        const now = new Date();

        const [updated] = await tx
          .update(expenses)
          .set({ receiptStorageKey: key, receiptUploadedAt: now, updatedAt: now })
          .where(and(eq(expenses.id, id), eq(expenses.accountId, accountId)))
          .returning();
        if (!updated) return c.json({ error: 'expense_not_found' }, 404);

        await c.var.audit({
          entityType: 'expense',
          entityId: id,
          action: 'receipt-upload',
          before: {
            receiptStorageKey: expense.receiptStorageKey,
            receiptUploadedAt: expense.receiptUploadedAt,
          },
          after: { receiptStorageKey: key, receiptUploadedAt: now },
          companyId: expense.companyId,
        });

        await deps.storage.putObject({ key, body: bytes, contentType: file.type });

        return c.json({ id, receiptStorageKey: key, receiptUploadedAt: now }, 201);
      })
      // 1-hour signed download URL. For s3 it's a presigned object-store URL
      // the browser fetches directly; for local-FS it's a relative
      // /api/files/<token> the api serves itself.
      .get('/api/expenses/:id/receipt', async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        if (!deps.storage) return c.json({ error: 'storage_not_configured' }, 503);

        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const [expense] = await tx
          .select({
            receiptStorageKey: expenses.receiptStorageKey,
            deletedAt: expenses.deletedAt,
          })
          .from(expenses)
          .where(and(eq(expenses.id, id), eq(expenses.accountId, accountId)))
          .limit(1);
        if (!expense || expense.deletedAt) return c.json({ error: 'expense_not_found' }, 404);
        if (!expense.receiptStorageKey) return c.json({ error: 'no_receipt' }, 404);

        const url = await deps.storage.getSignedDownloadUrl(expense.receiptStorageKey, {
          expiresInSeconds: 3600,
        });
        return c.json({ url, contentType: mimeForKey(expense.receiptStorageKey) });
      })
      // Delete the receipt: null the columns + audit, then drop the object as
      // the LAST await so a storage failure rolls the nulling back (the key
      // keeps pointing at a still-present object — consistent). deleteObject
      // is idempotent.
      .delete('/api/expenses/:id/receipt', async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        if (!deps.storage) return c.json({ error: 'storage_not_configured' }, 503);

        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const [expense] = await tx
          .select()
          .from(expenses)
          .where(and(eq(expenses.id, id), eq(expenses.accountId, accountId)))
          .limit(1);
        if (!expense || expense.deletedAt) return c.json({ error: 'expense_not_found' }, 404);
        if (!expense.receiptStorageKey) return c.json({ error: 'no_receipt' }, 404);

        const oldKey = expense.receiptStorageKey;
        const now = new Date();
        const [updated] = await tx
          .update(expenses)
          .set({ receiptStorageKey: null, receiptUploadedAt: null, updatedAt: now })
          .where(and(eq(expenses.id, id), eq(expenses.accountId, accountId)))
          .returning();
        if (!updated) return c.json({ error: 'expense_not_found' }, 404);

        await c.var.audit({
          entityType: 'expense',
          entityId: id,
          action: 'receipt-delete',
          before: { receiptStorageKey: oldKey, receiptUploadedAt: expense.receiptUploadedAt },
          after: { receiptStorageKey: null, receiptUploadedAt: null },
          companyId: expense.companyId,
        });

        await deps.storage.deleteObject(oldKey);

        return c.json({ id, deleted: true });
      })
      // ---- Receipt extraction (slice 8.9h) ------------------------------
      // Pro+/BYOK: a vision model reads the stored receipt and suggests
      // merchant / total / date / tax / category. The user reviews + saves —
      // the AI never writes the ledger directly. Opt-in like storage/stripe:
      // 503 when no LLM provider is configured. Sync per locked decision #7
      // (move behind pg-boss if P95 crosses ~3s). The model call runs inside
      // the tenant tx; on failure we still commit extraction_status='failed'
      // (the 8.5b email-path shape) so the throw doesn't roll back the status —
      // the UI needs to see that it failed and let the user retry.
      .post('/api/expenses/:id/extract', async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        if (!deps.extractor) return c.json({ error: 'ai_not_configured' }, 503);
        if (!deps.storage) return c.json({ error: 'storage_not_configured' }, 503);

        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const [expense] = await tx
          .select()
          .from(expenses)
          .where(and(eq(expenses.id, id), eq(expenses.accountId, accountId)))
          .limit(1);
        if (!expense || expense.deletedAt) return c.json({ error: 'expense_not_found' }, 404);
        // Extraction operates on the already-uploaded receipt (capture is 8.9g).
        if (!expense.receiptStorageKey) return c.json({ error: 'no_receipt' }, 400);

        // The company's active expense COA. The model's category suggestion is
        // constrained to these codes (in the prompt and by post-hoc validation
        // inside the extractor) so it can't return a code that wouldn't post.
        const categories = await tx
          .select({
            id: chartOfAccounts.id,
            code: chartOfAccounts.code,
            name: chartOfAccounts.name,
          })
          .from(chartOfAccounts)
          .where(
            and(
              eq(chartOfAccounts.accountId, accountId),
              eq(chartOfAccounts.companyId, expense.companyId),
              eq(chartOfAccounts.accountType, 'expense'),
              eq(chartOfAccounts.isActive, true),
            ),
          )
          .orderBy(asc(chartOfAccounts.code));

        const bytes = await deps.storage.getObject(expense.receiptStorageKey);
        const mimeType = mimeForKey(expense.receiptStorageKey);

        const now = new Date();
        let result: ExtractionResult | null = null;
        let status: 'succeeded' | 'failed';
        try {
          result = await deps.extractor.extractReceipt({
            bytes,
            mimeType,
            allowedCategories: categories.map((row) => ({ code: row.code, name: row.name })),
          });
          status = 'succeeded';
        } catch (_err) {
          status = 'failed';
        }

        const [updated] = await tx
          .update(expenses)
          .set({ extractionStatus: status, extractionPayload: result, updatedAt: now })
          .where(and(eq(expenses.id, id), eq(expenses.accountId, accountId)))
          .returning();
        if (!updated) return c.json({ error: 'expense_not_found' }, 404);

        await c.var.audit({
          entityType: 'expense',
          entityId: id,
          action: 'receipt-extract',
          before: { extractionStatus: expense.extractionStatus },
          after: { extractionStatus: status, extraction: result },
          companyId: expense.companyId,
        });

        if (status === 'failed' || !result) {
          // Status committed as 'failed' above; surface a 502 without throwing
          // so the tx still commits.
          return c.json({ error: 'extraction_failed', extractionStatus: 'failed' as const }, 502);
        }

        // Resolve the suggested code → account id for the web prefill. Codes are
        // the stable, persisted form; the edit form's category select is keyed
        // by id. Null when the model suggested nothing or a now-removed code.
        const suggestedCategoryAccountId = result.suggestedCategoryCode
          ? (categories.find((row) => row.code === result?.suggestedCategoryCode)?.id ?? null)
          : null;

        // Telemetry (opt-in; no-op unless the account enabled it). The AI did
        // the categorisation work when it returned a usable code; the user
        // still confirms on save. expense_categorised{ai_suggested} is the
        // documented event for this (TELEMETRY.md).
        if (result.suggestedCategoryCode) {
          await emit(tx, { name: 'expense_categorised', method: 'ai_suggested' });
        }

        return c.json({
          extractionStatus: 'succeeded' as const,
          extraction: result,
          suggestedCategoryAccountId,
        });
      })
      // Local-FS receipt serving. Public path (rls-context skips /api/files/*):
      // the HMAC-signed token IS the credential. 404s when the local driver
      // isn't active (s3 signed URLs never route here). The token already
      // encodes + signs the key, so there's no per-tenant check — minting the
      // token (the authenticated GET /receipt above) is the authorization
      // gate.
      .get('/api/files/:token', async (c) => {
        const fileServe = deps.localFileServe;
        if (!fileServe) return c.json({ error: 'not_found' }, 404);
        const payload = verifyFileToken(c.req.param('token'), fileServe.secret);
        if (!payload) return c.json({ error: 'invalid_or_expired_token' }, 403);

        let bytes: Buffer;
        try {
          bytes = await readLocalObject(fileServe.baseDir, payload.key);
        } catch {
          return c.json({ error: 'not_found' }, 404);
        }
        return c.body(new Uint8Array(bytes), 200, {
          'content-type': mimeForKey(payload.key),
          'cache-control': 'private, max-age=3600',
        });
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
            .select({ name: companies.name, replyToEmail: companies.replyToEmail })
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
          // Shared builder (lib/invoice-email.ts) so this route and the
          // recurring-invoice sweeper emit identical email. publicToken is
          // guaranteed set by the guard above.
          let subject: string;
          try {
            ({ subject } = await sendInvoiceEmail(deps.mailer, to, {
              invoice: { ...invoice, publicToken: invoice.publicToken },
              customerName: customer.name,
              companyName,
              publicAppUrl: deps.publicAppUrl,
              emailFrom: deps.emailFrom,
              replyToEmail: company?.replyToEmail ?? null,
            }));
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
            .select({ name: companies.name, replyToEmail: companies.replyToEmail })
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
            await deps.mailer.send({
              to,
              subject,
              html,
              text,
              // See invoice /send: company-named From, company-routed Reply-To.
              from: deps.emailFrom ? formatSender(deps.emailFrom, companyName) : undefined,
              replyTo: company?.replyToEmail ?? undefined,
            });
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
        const ALLOWED_TYPES = [
          'customer',
          'invoice',
          'estimate',
          'expense',
          'recurring_invoice',
        ] as const;
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
            expense: [],
            recurring_invoice: [],
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
          if (idsByType.expense.length > 0) {
            const expRows = await tx
              .select({ id: expenses.id, label: expenses.merchant })
              .from(expenses)
              .where(
                and(eq(expenses.accountId, accountId), inArray(expenses.id, idsByType.expense)),
              );
            for (const r of expRows) labelMap.set(`expense:${r.id}`, r.label);
          }
          // Schedules have no number — label them by customer name (joined).
          if (idsByType.recurring_invoice.length > 0) {
            const recRows = await tx
              .select({ id: recurringInvoices.id, label: customers.name })
              .from(recurringInvoices)
              .innerJoin(customers, eq(customers.id, recurringInvoices.customerId))
              .where(
                and(
                  eq(recurringInvoices.accountId, accountId),
                  inArray(recurringInvoices.id, idsByType.recurring_invoice),
                ),
              );
            for (const r of recRows) labelMap.set(`recurring_invoice:${r.id}`, r.label);
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
            businessAddress: companies.businessAddress,
            businessPhone: companies.businessPhone,
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
          companyAddress: company?.businessAddress ?? null,
          companyPhone: company?.businessPhone ?? null,
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
      .post('/api/public/invoices/:token/payment-intent', async (c) => {
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

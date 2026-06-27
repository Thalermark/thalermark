import { createHash, randomBytes } from 'node:crypto';
import * as Sentry from '@sentry/node';
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
  bills,
  chartOfAccounts,
  companies,
  contacts,
  emailTemplates,
  estimateLineItems,
  estimates,
  expenses,
  invitations,
  invoiceLineItems,
  invoices,
  items,
  journalEntries,
  journalLines,
  memberships,
  seedChartOfAccounts,
} from '@thalermark/db';
import type { AddressAutocompleteProvider } from '@thalermark/location';
import { getLogger } from '@thalermark/logger';
import type { StorageProvider } from '@thalermark/storage';
import {
  disableTelemetry,
  emit,
  enableTelemetry,
  isTelemetryDisabled,
} from '@thalermark/telemetry';
import {
  EMAIL_TEMPLATE_PLACEHOLDERS,
  EMAIL_TEMPLATE_TYPES,
  billCreateSchema,
  billMarkPaidSchema,
  billUpdateSchema,
  can,
  companyCreateSchema,
  companyUpdateSchema,
  emailTemplateTypeSchema,
  emailTemplateUpdateSchema,
  expenseCategorizeSchema,
  expenseCreateSchema,
  expenseUpdateSchema,
  inviteRoleSchema,
  telemetryUpdateSchema,
  unknownPlaceholders,
} from '@thalermark/validation';
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  gte,
  ilike,
  inArray,
  isNull,
  lt,
  lte,
  sql,
} from 'drizzle-orm';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { validator } from 'hono/validator';
import { v7 as uuidv7 } from 'uuid';
import type { ApiAuth } from './lib/auth.js';
import { emailFooterText, renderEmailHtml } from './lib/email-layout.js';
import { buildEmailPreview } from './lib/email-preview.js';
import { DEFAULT_TEMPLATES } from './lib/email-templates.js';
import {
  apBalance,
  arBalance,
  cashFlowNet,
  cashOnHand,
  postBillOpen,
  postBillOpenReversal,
  postBillPayment,
  postExpenseCreate,
  postExpenseReversal,
  postInvoiceTransition,
} from './lib/ledger.js';
import type { Mailer } from './lib/mailer.js';
import { applyCursor, keysetOrderBy, parseLimit, slicePage } from './lib/pagination.js';
import { EMAIL_RE, UUID_RE, escapeLike, mimeForKey } from './lib/route-helpers.js';
import { type StripeBundle, decimalDollarsToCents } from './lib/stripe.js';
import { requireCapability } from './middleware/authz.js';
import { type RlsVariables, rlsContext } from './middleware/rls-context.js';
import { auditEventsRoutes } from './routes/audit-events.js';
import { contactsRoutes } from './routes/contacts.js';
import { estimatesRoutes } from './routes/estimates.js';
import { filesRoutes } from './routes/files.js';
import { invoicesRoutes } from './routes/invoices.js';
import { itemsRoutes } from './routes/items.js';
import { locationsRoutes } from './routes/locations.js';
import { recurringInvoicesRoutes } from './routes/recurring.js';
import { socialProvidersRoutes } from './routes/social-providers.js';
import { taxPoliciesRoutes } from './routes/tax-policies.js';
import { telemetryRoutes } from './routes/telemetry.js';

const log = getLogger(['api', 'app']);

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Parse a from/to reporting window shared by the report endpoints. Both are
// optional; the default is year-to-date through today. Returns the half-open
// [fromDate, toExclusive) (to + 1 day, so the last day is fully included — the
// same convention as the ledger export / dashboard) plus the inclusive display
// strings; or an `error` code the caller turns into a 400. `from`/`to` are also
// suitable for direct comparison against bare `date` columns (issue_date), which
// compare inclusively on both ends.
type ReportWindow = { fromDate: Date; toExclusive: Date; from: string; to: string };
function parseReportWindow(
  fromRaw: string | undefined,
  toRaw: string | undefined,
): ReportWindow | { error: 'invalid_from' | 'invalid_to' | 'invalid_range' } {
  const now = new Date();
  let fromDate: Date;
  if (fromRaw !== undefined) {
    fromDate = new Date(`${fromRaw}T00:00:00Z`);
    if (Number.isNaN(fromDate.getTime())) return { error: 'invalid_from' };
  } else {
    fromDate = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  }
  let toExclusive: Date;
  if (toRaw !== undefined) {
    const t = new Date(`${toRaw}T00:00:00Z`);
    if (Number.isNaN(t.getTime())) return { error: 'invalid_to' };
    toExclusive = new Date(t);
  } else {
    toExclusive = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }
  toExclusive.setUTCDate(toExclusive.getUTCDate() + 1);
  if (fromDate >= toExclusive) return { error: 'invalid_range' };
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  const toInclusive = new Date(toExclusive);
  toInclusive.setUTCDate(toInclusive.getUTCDate() - 1);
  return { fromDate, toExclusive, from: ymd(fromDate), to: ymd(toInclusive) };
}

// Parse a single as-of date (YYYY-MM-DD) for point-in-time reports (balance
// sheet, A/R aging). Default is today. Returns the inclusive display string +
// the half-open upper bound (asOf + 1 day) so a balance includes everything
// posted any time on the as-of day; or an `error` for a 400.
function parseAsOf(
  raw: string | undefined,
): { asOf: string; asOfExclusive: Date } | { error: 'invalid_as_of' } {
  const now = new Date();
  let d: Date;
  if (raw !== undefined) {
    d = new Date(`${raw}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return { error: 'invalid_as_of' };
  } else {
    d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }
  const asOf = d.toISOString().slice(0, 10);
  const asOfExclusive = new Date(d);
  asOfExclusive.setUTCDate(asOfExclusive.getUTCDate() + 1);
  return { asOf, asOfExclusive };
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

// Bills post against the bill date (the open leg) and the payment date (the
// paid leg) for the same accrual reason as expenses — a bill dated in the prior
// tax period must land there. Reuses expenseDateToPostedAt for the date→midnight
// conversion; this aliases it for readability at the bill call sites.
const billDateToPostedAt = expenseDateToPostedAt;

// GL memo label for a bill's journal entries: the vendor name, plus the
// vendor's own reference number when present, so the ledger reads like
// "Bill Ace Hardware #INV-9912 open".
function billMemoLabel(vendorName: string, reference: string | null | undefined): string {
  return reference ? `${vendorName} #${reference}` : vendorName;
}

// AP aging report shapes. Named so the /api/bills/aging response is a type
// REFERENCE in the hc<AppType>() route schema rather than a large inline object
// literal — the Hono chain's inferred type is at the compiler's serialization
// ceiling (TS7056), and a fat inline response tips it over.
type ApAgingBucket = 'current' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90_plus';
type ApAgingResponse = {
  asOf: string;
  buckets: Record<ApAgingBucket, string>;
  total: string;
  bills: {
    id: string;
    contactId: string;
    vendorName: string;
    reference: string | null;
    billDate: string;
    dueDate: string;
    amount: string;
    daysOverdue: number;
    bucket: ApAgingBucket;
  }[];
};

// Receipt capture (slice 8.9g). All tiers; image always saved. 10 MB cap +
// the three formats a phone camera / scanner produces. The mime → extension
// map doubles as the upload allowlist.
const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;
const RECEIPT_MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'application/pdf': 'pdf',
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

// Resolve an expense's optional buy-from vendor link (shared by create +
// update). Returns null when nothing to link; an {error,status} pair for a bad
// link; otherwise the resolved {id,name} after marking the contact is_vendor.
// Marking is_vendor on link is how an existing customer-only contact becomes a
// vendor too — the buy-from half of the unified-contact relationship view.
// Callers mirror the returned name into expenses.merchant so the single
// on-screen "Vendor" field stays the display string.
async function resolveVendorLink(
  tx: Transaction,
  accountId: string,
  companyId: string,
  vendorContactId: string | null | undefined,
): Promise<{ id: string; name: string } | { error: string; status: 400 | 404 } | null> {
  if (!vendorContactId) return null;
  const [vendor] = await tx
    .select({
      id: contacts.id,
      companyId: contacts.companyId,
      name: contacts.name,
      isVendor: contacts.isVendor,
    })
    .from(contacts)
    .where(and(eq(contacts.id, vendorContactId), eq(contacts.accountId, accountId)))
    .limit(1);
  if (!vendor) return { error: 'contact_not_found', status: 404 };
  if (vendor.companyId !== companyId) return { error: 'vendor_company_mismatch', status: 400 };
  if (!vendor.isVendor) {
    await tx
      .update(contacts)
      .set({ isVendor: true, updatedAt: new Date() })
      .where(and(eq(contacts.id, vendorContactId), eq(contacts.accountId, accountId)));
  }
  return { id: vendor.id, name: vendor.name };
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
  // Configured social-login provider ids ('google' | 'facebook' | 'twitter'),
  // surfaced by GET /api/social-providers so the web sign-in page renders only
  // the buttons that will work. Empty/omitted = email/password only. Built in
  // server.ts from env via enabledSocialProviders().
  socialProviders?: string[];
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
  // Address autocomplete provider for the mobile customer form's
  // /api/locations/autocomplete route (the web client uses its own same-origin
  // SvelteKit proxy). Null when construction failed (e.g. LOCATION_PROVIDER set
  // to an unknown name, or mapbox without a token) — the route then degrades to
  // empty suggestions rather than erroring. The keyless US Census geocoder is
  // the no-config default, so this is normally set. Built in server.ts from env.
  addressProvider?: AddressAutocompleteProvider | null;
};

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Routes are chained so Hono's type system carries each route's path + handler
// shape through to AppType, which Phase 4's packages/api-contract re-exports
// for hc<AppType>() clients. Breaking the chain (e.g. `app.get(...); app.get(...)`)
// erases that schema back to an empty Hono.
// Bills (accounts payable) routes, factored into their own Hono instance and
// mounted on createApp via .route(). The main chain sits at the TypeScript
// type-serialization ceiling (TS7056); a separate sub-app keeps each inferred
// type under budget while .route() still threads the schema into AppType for
// hc<AppType>() clients. No deps needed — the parent cors + rlsContext
// middleware runs for these paths (registered before the mount).
function billsRoutes() {
  return (
    new Hono<{ Variables: RlsVariables }>()
      // ---- Bills (accounts payable) -------------------------------------
      // The accrual sibling of expenses: a bill recognises a cost you owe now
      // (Dr <category> / Cr Accounts Payable) and is settled later (Dr AP / Cr
      // <payment asset>). Same hidden-ledger discipline as every other entity —
      // row write + audit + posting in one tenant tx so the deferred sum-to-zero
      // trigger fires at commit and a posting failure rolls the mutation back.
      // No draft state: a bill is 'open' on create (posts the open entry),
      // 'paid' on settle, or 'voided' (reverses the open entry). Edit is allowed
      // only while 'open' (reverse + repost). Gated by expenses:write — managing
      // payables is the same capability cluster as expenses (the accountant role
      // has it). entityType 'bill' is registered in the activity feed above.
      .post('/api/bills', requireCapability('expenses:write'), async (c) => {
        const body = await c.req.json().catch(() => null);
        const parsed = billCreateSchema.safeParse(body);
        if (!parsed.success) {
          return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
        }

        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const { companyId, contactId, categoryAccountId, ...rest } = parsed.data;

        const [company] = await tx
          .select({ id: companies.id })
          .from(companies)
          .where(and(eq(companies.id, companyId), eq(companies.accountId, accountId)))
          .limit(1);
        if (!company) return c.json({ error: 'company_not_found' }, 404);

        // The bill's contact is the vendor: validate same account+company and
        // mark is_vendor (resolveVendorLink does both — recording a bill against
        // a contact makes them a vendor, the buy-from half of the relationship).
        const vendor = await resolveVendorLink(tx, accountId, companyId, contactId);
        if (!vendor) return c.json({ error: 'contact_not_found' }, 404);
        if ('error' in vendor) return c.json({ error: vendor.error }, vendor.status);

        // category must be an 'expense' COA row (the Dr side of the open entry).
        const coa = await resolveCoaAccounts(tx, accountId, companyId, [categoryAccountId]);
        const category = coa.get(categoryAccountId);
        if (!category || category.accountType !== 'expense') {
          return c.json({ error: 'invalid_category_account' }, 400);
        }

        const billId = uuidv7();
        const [created] = await tx
          .insert(bills)
          .values({
            id: billId,
            accountId,
            companyId,
            contactId,
            categoryAccountId,
            amount: rest.amount,
            billDate: rest.billDate,
            dueDate: rest.dueDate,
            currency: rest.currency ?? 'USD',
            reference: rest.reference ?? null,
            memo: rest.memo ?? null,
            status: 'open',
          })
          .returning();

        await c.var.audit({
          entityType: 'bill',
          entityId: billId,
          action: 'create',
          after: created,
          companyId,
        });

        await postBillOpen(tx, {
          bill: {
            id: billId,
            amount: rest.amount,
            label: billMemoLabel(vendor.name, rest.reference),
          },
          categoryCode: category.code,
          accountId,
          companyId,
          postedAt: billDateToPostedAt(rest.billDate),
        });

        return c.json(created, 201);
      })
      .get('/api/bills', async (c) => {
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const companyId = c.req.query('companyId');
        const status = c.req.query('status');
        const contactId = c.req.query('contactId');

        const limit = parseLimit(c.req.query('limit'));
        if (limit === null) return c.json({ error: 'invalid_limit' }, 400);
        const keys = [
          { col: bills.createdAt, revive: (v: unknown) => new Date(v as string) },
          { col: bills.id },
        ];
        const keyset = applyCursor(c.req.query('cursor'), keys, 'desc');
        if (keyset === 'invalid') return c.json({ error: 'invalid_cursor' }, 400);

        const conditions = [eq(bills.accountId, accountId)];
        if (companyId) conditions.push(eq(bills.companyId, companyId));
        if (status) conditions.push(eq(bills.status, status));
        if (contactId) conditions.push(eq(bills.contactId, contactId));
        if (keyset) conditions.push(keyset);

        const rows = await tx
          .select({ ...getTableColumns(bills), vendorName: contacts.name })
          .from(bills)
          .innerJoin(contacts, eq(contacts.id, bills.contactId))
          .where(and(...conditions))
          .orderBy(keysetOrderBy(keys, 'desc'))
          .limit(limit + 1);
        const page = slicePage(rows, limit, (r) => [r.createdAt, r.id]);
        return c.json({ bills: page.rows, nextCursor: page.nextCursor });
      })
      // AP aging — the payoff the audit flagged. Open bills bucketed by how far
      // past due they are (current / 1-30 / 31-60 / 61-90 / 90+), with per-bill
      // rows carrying the vendor name + days overdue so the UI renders a real
      // aging table. Computed in JS off the open-bill set (backed by
      // bills_open_due_idx) — MVP payable volumes don't warrant a SQL pivot.
      // Literal path, registered before /api/bills/:id so "aging" isn't eaten by
      // the :id param.
      .get('/api/bills/aging', async (c) => {
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const companyId = c.req.query('companyId');
        if (!companyId || !UUID_RE.test(companyId)) {
          return c.json({ error: 'company_id_required' }, 400);
        }

        const rows = await tx
          .select({
            id: bills.id,
            contactId: bills.contactId,
            vendorName: contacts.name,
            reference: bills.reference,
            billDate: bills.billDate,
            dueDate: bills.dueDate,
            amount: bills.amount,
          })
          .from(bills)
          .innerJoin(contacts, eq(contacts.id, bills.contactId))
          .where(
            and(
              eq(bills.accountId, accountId),
              eq(bills.companyId, companyId),
              eq(bills.status, 'open'),
            ),
          )
          .orderBy(asc(bills.dueDate), asc(bills.id));

        const asOf = new Date().toISOString().slice(0, 10);
        const todayMs = Date.parse(`${asOf}T00:00:00Z`);
        const bucketCents: Record<ApAgingBucket, number> = {
          current: 0,
          d1_30: 0,
          d31_60: 0,
          d61_90: 0,
          d90_plus: 0,
        };
        let totalCents = 0;
        const aged = rows.map((r) => {
          const daysOverdue = Math.floor(
            (todayMs - Date.parse(`${r.dueDate}T00:00:00Z`)) / 86_400_000,
          );
          const bucket: ApAgingBucket =
            daysOverdue <= 0
              ? 'current'
              : daysOverdue <= 30
                ? 'd1_30'
                : daysOverdue <= 60
                  ? 'd31_60'
                  : daysOverdue <= 90
                    ? 'd61_90'
                    : 'd90_plus';
          const cents = Math.round(Number(r.amount) * 100);
          bucketCents[bucket] += cents;
          totalCents += cents;
          return { ...r, daysOverdue, bucket };
        });
        const fmt = (cents: number) => (cents / 100).toFixed(2);
        const payload: ApAgingResponse = {
          asOf,
          buckets: {
            current: fmt(bucketCents.current),
            d1_30: fmt(bucketCents.d1_30),
            d31_60: fmt(bucketCents.d31_60),
            d61_90: fmt(bucketCents.d61_90),
            d90_plus: fmt(bucketCents.d90_plus),
          },
          total: fmt(totalCents),
          bills: aged,
        };
        return c.json(payload);
      })
      .get('/api/bills/:id', async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const [bill] = await tx
          .select({ ...getTableColumns(bills), vendorName: contacts.name })
          .from(bills)
          .innerJoin(contacts, eq(contacts.id, bills.contactId))
          .where(and(eq(bills.id, id), eq(bills.accountId, accountId)))
          .limit(1);
        if (!bill) return c.json({ error: 'bill_not_found' }, 404);
        return c.json(bill);
      })
      .patch(
        '/api/bills/:id',
        requireCapability('expenses:write'),
        validator('json', (value, c) => {
          const parsed = billUpdateSchema.safeParse(value);
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
            .from(bills)
            .where(and(eq(bills.id, id), eq(bills.accountId, accountId)))
            .limit(1);
          if (!current) return c.json({ error: 'bill_not_found' }, 404);
          // Only open bills are editable — paid/voided are terminal, like a paid
          // invoice. Editing a settled bill would mean unwinding the payment too.
          if (current.status !== 'open') return c.json({ error: 'bill_not_editable' }, 409);

          // Sparse merge; companyId is immutable (omitted from the schema).
          const next = {
            contactId: data.contactId ?? current.contactId,
            categoryAccountId: data.categoryAccountId ?? current.categoryAccountId,
            amount: data.amount ?? current.amount,
            billDate: data.billDate ?? current.billDate,
            dueDate: data.dueDate ?? current.dueDate,
            currency: data.currency ?? current.currency,
            reference: data.reference !== undefined ? data.reference : current.reference,
            memo: data.memo !== undefined ? data.memo : current.memo,
          };

          // Reassigning the vendor: validate + mark is_vendor on the new contact.
          if (data.contactId !== undefined && data.contactId !== current.contactId) {
            const vendor = await resolveVendorLink(
              tx,
              accountId,
              current.companyId,
              data.contactId,
            );
            if (!vendor) return c.json({ error: 'contact_not_found' }, 404);
            if ('error' in vendor) return c.json({ error: vendor.error }, vendor.status);
          }

          // Resolve old + new category codes in one round trip; new must be an
          // expense account, old supplies the reversal code.
          const coa = await resolveCoaAccounts(tx, accountId, current.companyId, [
            current.categoryAccountId,
            next.categoryAccountId,
          ]);
          const newCategory = coa.get(next.categoryAccountId);
          if (!newCategory || newCategory.accountType !== 'expense') {
            return c.json({ error: 'invalid_category_account' }, 400);
          }
          const oldCategory = coa.get(current.categoryAccountId);
          if (!oldCategory) {
            throw new Error(`bill ${id}: stored category account missing`);
          }

          // Vendor names for the reversal (old contact) + repost (new contact)
          // memos — one lookup over both ids.
          const vendorRows = await tx
            .select({ id: contacts.id, name: contacts.name })
            .from(contacts)
            .where(
              and(
                eq(contacts.accountId, accountId),
                inArray(contacts.id, Array.from(new Set([current.contactId, next.contactId]))),
              ),
            );
          const nameById = new Map(vendorRows.map((r) => [r.id, r.name]));

          // Edit = reverse the prior open posting (old account/amount, old bill
          // date) + repost the new one. Keeps the GL append-only.
          await postBillOpenReversal(tx, {
            bill: {
              id,
              amount: current.amount,
              label: billMemoLabel(nameById.get(current.contactId) ?? 'vendor', current.reference),
            },
            categoryCode: oldCategory.code,
            accountId,
            companyId: current.companyId,
            postedAt: billDateToPostedAt(current.billDate),
          });

          const [updated] = await tx
            .update(bills)
            .set({
              contactId: next.contactId,
              categoryAccountId: next.categoryAccountId,
              amount: next.amount,
              billDate: next.billDate,
              dueDate: next.dueDate,
              currency: next.currency,
              reference: next.reference ?? null,
              memo: next.memo ?? null,
              updatedAt: new Date(),
            })
            .where(and(eq(bills.id, id), eq(bills.accountId, accountId)))
            .returning();
          if (!updated) return c.json({ error: 'bill_not_found' }, 404);

          await c.var.audit({
            entityType: 'bill',
            entityId: id,
            action: 'update',
            before: current,
            after: updated,
            companyId: current.companyId,
          });

          await postBillOpen(tx, {
            bill: {
              id,
              amount: next.amount,
              label: billMemoLabel(nameById.get(next.contactId) ?? 'vendor', next.reference),
            },
            categoryCode: newCategory.code,
            accountId,
            companyId: current.companyId,
            postedAt: billDateToPostedAt(next.billDate),
          });

          return c.json(updated);
        },
      )
      .post(
        '/api/bills/:id/mark-paid',
        requireCapability('expenses:write'),
        // validator middleware (not a manual parse) so hc<BillsAppType>() exposes
        // `json` on the typed client — same pattern as the invoice mark-paid.
        validator('json', (value, c) => {
          const parsed = billMarkPaidSchema.safeParse(value);
          if (!parsed.success) {
            return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
          }
          return parsed.data;
        }),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);

          const tx = c.get('tx');
          const accountId = c.get('accountId');
          const { method, paymentAccountId, reference, paidOn } = c.req.valid('json');

          const [current] = await tx
            .select()
            .from(bills)
            .where(and(eq(bills.id, id), eq(bills.accountId, accountId)))
            .limit(1);
          if (!current) return c.json({ error: 'bill_not_found' }, 404);
          if (current.status !== 'open') return c.json({ error: 'invalid_transition' }, 409);

          // Resolve the payment asset: an explicit pick (validated 'asset') or the
          // company's Cash (1000) default — the single-Cash MVP seed.
          let paymentCode: string;
          let resolvedPaymentAccountId: string;
          if (paymentAccountId) {
            const coa = await resolveCoaAccounts(tx, accountId, current.companyId, [
              paymentAccountId,
            ]);
            const payment = coa.get(paymentAccountId);
            if (!payment || payment.accountType !== 'asset') {
              return c.json({ error: 'invalid_payment_account' }, 400);
            }
            paymentCode = payment.code;
            resolvedPaymentAccountId = paymentAccountId;
          } else {
            const [cash] = await tx
              .select({ id: chartOfAccounts.id, code: chartOfAccounts.code })
              .from(chartOfAccounts)
              .where(
                and(
                  eq(chartOfAccounts.accountId, accountId),
                  eq(chartOfAccounts.companyId, current.companyId),
                  eq(chartOfAccounts.code, '1000'),
                ),
              )
              .limit(1);
            if (!cash) throw new Error(`bill ${id}: Cash account missing for company`);
            paymentCode = cash.code;
            resolvedPaymentAccountId = cash.id;
          }

          // Payment date drives both paidAt and the settlement posting date.
          const paidAt = paidOn ? new Date(`${paidOn}T00:00:00.000Z`) : new Date();

          const [updated] = await tx
            .update(bills)
            .set({
              status: 'paid',
              paymentAccountId: resolvedPaymentAccountId,
              paymentMethod: method,
              paymentReference: reference ?? null,
              paidAt,
              updatedAt: new Date(),
            })
            .where(and(eq(bills.id, id), eq(bills.accountId, accountId)))
            .returning();
          if (!updated) return c.json({ error: 'bill_not_found' }, 404);

          await c.var.audit({
            entityType: 'bill',
            entityId: id,
            action: 'mark-paid',
            before: current,
            after: updated,
            companyId: current.companyId,
          });

          const [vendor] = await tx
            .select({ name: contacts.name })
            .from(contacts)
            .where(and(eq(contacts.id, current.contactId), eq(contacts.accountId, accountId)))
            .limit(1);
          await postBillPayment(tx, {
            bill: {
              id,
              amount: current.amount,
              label: billMemoLabel(vendor?.name ?? 'vendor', current.reference),
            },
            paymentCode,
            accountId,
            companyId: current.companyId,
            postedAt: paidAt,
          });

          return c.json(updated);
        },
      )
      .post('/api/bills/:id/void', requireCapability('expenses:write'), async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        const tx = c.get('tx');
        const accountId = c.get('accountId');

        const [current] = await tx
          .select()
          .from(bills)
          .where(and(eq(bills.id, id), eq(bills.accountId, accountId)))
          .limit(1);
        if (!current) return c.json({ error: 'bill_not_found' }, 404);
        // Only open bills can be voided — voiding a paid bill would need to
        // unwind the settlement too (out of MVP scope, same as invoices).
        if (current.status !== 'open') return c.json({ error: 'invalid_transition' }, 409);

        const coa = await resolveCoaAccounts(tx, accountId, current.companyId, [
          current.categoryAccountId,
        ]);
        const category = coa.get(current.categoryAccountId);
        if (!category) throw new Error(`bill ${id}: stored category account missing`);

        const now = new Date();
        const [updated] = await tx
          .update(bills)
          .set({ status: 'voided', voidedAt: now, updatedAt: now })
          .where(and(eq(bills.id, id), eq(bills.accountId, accountId)))
          .returning();
        if (!updated) return c.json({ error: 'bill_not_found' }, 404);

        await c.var.audit({
          entityType: 'bill',
          entityId: id,
          action: 'void',
          before: current,
          after: updated,
          companyId: current.companyId,
        });

        const [vendor] = await tx
          .select({ name: contacts.name })
          .from(contacts)
          .where(and(eq(contacts.id, current.contactId), eq(contacts.accountId, accountId)))
          .limit(1);
        // Reverse the open posting at its original date so the period nets to
        // zero (the AP balance is reversal-safe regardless, but period reports
        // should tie out).
        await postBillOpenReversal(tx, {
          bill: {
            id,
            amount: current.amount,
            label: billMemoLabel(vendor?.name ?? 'vendor', current.reference),
          },
          categoryCode: category.code,
          accountId,
          companyId: current.companyId,
          postedAt: billDateToPostedAt(current.billDate),
        });

        return c.json(updated);
      })
  );
}

function createMainApp(deps: AppDeps) {
  const origins = deps.trustedOrigins ?? [];
  const bootstrapDb = deps.bootstrapDb ?? deps.db;
  return (
    new Hono<{ Variables: RlsVariables }>()
      // Bridge thrown handler/middleware errors into error tracking. Hono catches
      // exceptions raised inside route handlers and turns them into a 500, so Node
      // never sees them as "uncaught" — Sentry's global hooks (armed in server.ts)
      // would miss exactly the handled 500s we most want. Capture here, then return
      // the API's JSON error shape. Sentry.captureException is a no-op when the DSN
      // is unset (uninitialised), so this is safe on self-host. HTTPExceptions carry
      // their own intended response (e.g. a framework 4xx) and are not server faults,
      // so pass them straight through without capturing.
      .onError((err, c) => {
        if (err instanceof HTTPException) return err.getResponse();
        Sentry.captureException(err);
        log.error('unhandled request error: {msg}', {
          msg: err instanceof Error ? err.message : String(err),
        });
        return c.json({ error: 'internal_server_error' }, 500);
      })
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
          .select({
            accountId: memberships.accountId,
            name: accounts.name,
            role: memberships.role,
          })
          .from(memberships)
          .innerJoin(accounts, eq(memberships.accountId, accounts.id))
          .where(eq(memberships.userId, userId));
        return c.json({ user, memberships: rows });
      })
      .get('/api/me/invitations', async (c) => {
        // Pending invitations addressed to the session user's email. Bootstrap
        // path: the user is not yet a member of the inviting account, so this
        // reads via bootstrapDb (RLS would hide the rows without an account
        // context). Drives the "you have pending invitations" notice + the
        // accept/decline banners on the Workspace screen. Email is the trust
        // anchor (Better Auth lowercases it). Excludes accepted/declined/expired.
        const userId = c.get('userId');
        const [user] = await bootstrapDb
          .select({ email: authUser.email })
          .from(authUser)
          .where(eq(authUser.id, userId));
        if (!user) return c.json({ error: 'unauthorized' }, 401);
        const rows = await bootstrapDb
          .select({
            token: invitations.token,
            accountName: accounts.name,
            inviterName: authUser.name,
            expiresAt: invitations.expiresAt,
          })
          .from(invitations)
          .innerJoin(accounts, eq(accounts.id, invitations.accountId))
          .innerJoin(authUser, eq(authUser.id, invitations.invitedByUserId))
          .where(
            and(
              sql`lower(${invitations.email}) = lower(${user.email})`,
              isNull(invitations.acceptedAt),
              isNull(invitations.declinedAt),
              gt(invitations.expiresAt, new Date()),
            ),
          )
          .orderBy(desc(invitations.createdAt));
        return c.json({
          invitations: rows.map((r) => ({
            token: r.token,
            accountName: r.accountName,
            inviterName: r.inviterName,
            expiresAt: r.expiresAt.toISOString(),
          })),
        });
      })
      // Per-account telemetry consent (TELEMETRY.md). The state isn't sensitive
      // and every client needs `enabled` to decide whether to emit, so GET is
      // open to any member; only PATCH (changing the account-wide decision) is
      // settings:manage. `decided` drives the first-run prompt (false → show
      // it); `disabled` reflects the deployment-wide TELEMETRY_DISABLED kill
      // switch. Reads the single account row under RLS.
      .get('/api/account/telemetry', async (c) => {
        const tx = c.get('tx');
        const [row] = await tx
          .select({
            enabled: accounts.telemetryEnabled,
            decidedAt: accounts.telemetryDecidedAt,
          })
          .from(accounts)
          .limit(1);
        return c.json({
          enabled: row?.enabled ?? false,
          decided: row?.decidedAt != null,
          disabled: isTelemetryDisabled(),
        });
      })
      .patch('/api/account/telemetry', requireCapability('settings:manage'), async (c) => {
        const parsed = telemetryUpdateSchema.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
          return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
        }
        const tx = c.get('tx');
        // A deployment that forbids telemetry can't be opted into — collapse any
        // enable request to a decided opt-out so the prompt still stops, but no
        // collection is ever armed.
        if (isTelemetryDisabled() || !parsed.data.enabled) {
          await disableTelemetry(tx);
          return c.json({ enabled: false, decided: true, disabled: isTelemetryDisabled() });
        }
        await enableTelemetry(tx);
        return c.json({ enabled: true, decided: true, disabled: false });
      })
      .post('/api/invitations', requireCapability('team:manage'), async (c) => {
        const body = (await c.req.json().catch(() => null)) as {
          email?: unknown;
          role?: unknown;
        } | null;
        const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
        if (!EMAIL_RE.test(email)) return c.json({ error: 'invalid_email' }, 400);
        // Default to member when the client omits a role (the prior behaviour);
        // an explicit role must be one of the four invitable ones (owner is
        // transfer-only, so inviteRoleSchema rejects it).
        const roleResult = inviteRoleSchema.safeParse(body?.role ?? 'member');
        if (!roleResult.success) return c.json({ error: 'invalid_role' }, 400);
        const role = roleResult.data;

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
          role,
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
            subject: "You're invited to a workspace on Thalermark",
            text: `You've been invited to join a workspace on Thalermark — AI-first accounting for freelancers and tradespeople.\n\nAccept the invitation: ${url}\n\nThis invitation expires in 7 days. If you weren't expecting it, you can ignore this email.\n\n${emailFooterText(false)}\n`,
            html: renderEmailHtml({
              brandName: 'Thalermark',
              preheader: "You've been invited to join a workspace on Thalermark.",
              heading: "You're invited",
              bodyHtml:
                '<p style="margin:0;">You\'ve been invited to join a workspace on <strong>Thalermark</strong> — AI-first accounting for freelancers and tradespeople.</p>',
              cta: { label: 'Accept invitation', url },
              footnote:
                "This invitation expires in 7 days. If you weren't expecting it, you can ignore this email.",
            }),
          });
        } catch {
          return c.json({ error: 'mailer_send_failed' }, 502);
        }

        return c.json({ id, email, token, expiresAt: expiresAt.toISOString() }, 201);
      })
      .post('/api/invitations/:token/accept', async (c) => {
        // Bootstrap path: rls-context set userId from the session but did not
        // open a tenant tx (the accepting user is not yet a member, so no
        // account context is set). Read + write via bootstrapDb (RLS-bypass):
        // under the app role the invitation + membership rows are invisible
        // without app.current_account_id, so deps.db would 404 every accept and
        // the membership insert would be blocked. Token uniqueness + the
        // freshness/email checks below are the gate.
        const userId = c.get('userId');
        const [user] = await bootstrapDb
          .select({ id: authUser.id, email: authUser.email })
          .from(authUser)
          .where(eq(authUser.id, userId));
        if (!user) return c.json({ error: 'unauthorized' }, 401);

        const token = c.req.param('token');
        const [invite] = await bootstrapDb
          .select()
          .from(invitations)
          .where(
            and(
              eq(invitations.token, token),
              isNull(invitations.acceptedAt),
              isNull(invitations.declinedAt),
            ),
          );
        if (!invite) return c.json({ error: 'invite_not_found' }, 404);
        if (invite.expiresAt.getTime() < Date.now())
          return c.json({ error: 'invite_expired' }, 410);
        if (invite.email.toLowerCase() !== user.email.toLowerCase()) {
          return c.json({ error: 'invite_email_mismatch' }, 403);
        }

        const acceptedAt = new Date();
        await bootstrapDb.transaction(async (tx) => {
          await tx
            .insert(memberships)
            .values({
              id: uuidv7(),
              userId: user.id,
              accountId: invite.accountId,
              role: invite.role,
            })
            .onConflictDoNothing({ target: [memberships.userId, memberships.accountId] });
          await tx
            .update(invitations)
            .set({ acceptedAt, acceptedByUserId: user.id, updatedAt: acceptedAt })
            .where(eq(invitations.id, invite.id));
        });

        return c.json({ accountId: invite.accountId });
      })
      .post('/api/invitations/:token/decline', async (c) => {
        // Bootstrap sibling of /accept: the invitee declines. Same gate (session
        // + email match) and same bootstrapDb path (the user is not a member of
        // the inviting account). Stamps declined_at so the inviter sees the
        // outcome on the team page; idempotent (a second decline returns ok).
        const userId = c.get('userId');
        const [user] = await bootstrapDb
          .select({ id: authUser.id, email: authUser.email })
          .from(authUser)
          .where(eq(authUser.id, userId));
        if (!user) return c.json({ error: 'unauthorized' }, 401);

        const token = c.req.param('token');
        const [invite] = await bootstrapDb
          .select()
          .from(invitations)
          .where(eq(invitations.token, token));
        if (!invite) return c.json({ error: 'invite_not_found' }, 404);
        if (invite.email.toLowerCase() !== user.email.toLowerCase()) {
          return c.json({ error: 'invite_email_mismatch' }, 403);
        }
        // Already consumed the other way — surface it rather than silently
        // overwriting an acceptance with a decline.
        if (invite.acceptedAt) return c.json({ error: 'invite_already_accepted' }, 409);

        if (!invite.declinedAt) {
          const now = new Date();
          await bootstrapDb
            .update(invitations)
            .set({ declinedAt: now, updatedAt: now })
            .where(eq(invitations.id, invite.id));
        }
        return c.json({ ok: true });
      })
      .get('/api/invitations/:token', async (c) => {
        // Public invite preview (token-gated, no session — the invitee may not
        // have signed up yet). Powers the sign-up email prefill + the
        // existing-user accept prompt ("X invites you to Org"). Via bootstrapDb:
        // the viewer isn't a member, so RLS would hide the row.
        const token = c.req.param('token');
        const [row] = await bootstrapDb
          .select({
            email: invitations.email,
            accountName: accounts.name,
            inviterName: authUser.name,
            expiresAt: invitations.expiresAt,
            acceptedAt: invitations.acceptedAt,
          })
          .from(invitations)
          .innerJoin(accounts, eq(accounts.id, invitations.accountId))
          .innerJoin(authUser, eq(authUser.id, invitations.invitedByUserId))
          .where(eq(invitations.token, token))
          .limit(1);
        if (!row) return c.json({ error: 'invite_not_found' }, 404);
        return c.json({
          email: row.email,
          accountName: row.accountName,
          inviterName: row.inviterName,
          expired: row.expiresAt.getTime() < Date.now(),
          accepted: row.acceptedAt !== null,
        });
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
            role: memberships.role,
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
            declinedAt: invitations.declinedAt,
          })
          .from(invitations)
          .where(and(eq(invitations.accountId, accountId), isNull(invitations.acceptedAt)))
          .orderBy(desc(invitations.createdAt));

        return c.json({
          members: memberRows.map((m) => ({
            userId: m.userId,
            name: m.name,
            email: m.email,
            role: m.role,
            joinedAt: m.joinedAt.toISOString(),
            isYou: m.userId === currentUserId,
          })),
          invitations: pending.map((p) => ({
            id: p.id,
            email: p.email,
            expiresAt: p.expiresAt.toISOString(),
            createdAt: p.createdAt.toISOString(),
            expired: p.expiresAt.getTime() < Date.now(),
            declined: p.declinedAt !== null,
          })),
        });
      })
      .delete('/api/team/:userId', async (c) => {
        // Remove a member from the current workspace, or leave it (when :userId
        // is the caller). Revokes access only — the auth_user and the workspace
        // data survive; the removed user hits account_revoked on their next
        // tenant request via the rls-context membership probe. The owner is
        // protected: cannot be removed and cannot leave — which also prevents
        // orphaning the workspace (the owner always remains). RLS permits the
        // DELETE because the membership row is account-scoped.
        //
        // No route-level requireCapability gate: this endpoint does double duty.
        // Removing SOMEONE ELSE needs team:manage; LEAVING (self-removal) is
        // self-service for any role. So the capability check below is conditional
        // on target !== caller.
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const audit = c.get('audit');
        const currentUserId = c.get('userId');
        const targetUserId = c.req.param('userId');
        if (!UUID_RE.test(targetUserId)) return c.json({ error: 'member_not_found' }, 404);
        if (targetUserId !== currentUserId && !can(c.get('role'), 'team:manage')) {
          return c.json({ error: 'forbidden', capability: 'team:manage' }, 403);
        }

        const [target] = await tx
          .select({ role: memberships.role })
          .from(memberships)
          .where(and(eq(memberships.accountId, accountId), eq(memberships.userId, targetUserId)))
          .limit(1);
        if (!target) return c.json({ error: 'member_not_found' }, 404);
        if (target.role === 'owner') return c.json({ error: 'cannot_remove_owner' }, 403);

        await tx
          .delete(memberships)
          .where(and(eq(memberships.accountId, accountId), eq(memberships.userId, targetUserId)));

        await audit({
          entityType: 'membership',
          entityId: targetUserId,
          action: targetUserId === currentUserId ? 'leave' : 'remove',
          before: { userId: targetUserId, role: target.role },
          after: null,
        });

        return c.json({ ok: true });
      })
      // Change a member's role within the workspace. team:manage gated; the
      // owner's role is fixed (reassigning ownership is the transfer flow), and
      // inviteRoleSchema excludes 'owner' so nobody is promoted to owner here.
      .patch(
        '/api/team/:userId/role',
        requireCapability('team:manage'),
        validator('json', (value, c) => {
          const parsed = inviteRoleSchema.safeParse((value as { role?: unknown } | null)?.role);
          if (!parsed.success) return c.json({ error: 'invalid_role' }, 400);
          return { role: parsed.data };
        }),
        async (c) => {
          const tx = c.get('tx');
          const accountId = c.get('accountId');
          const audit = c.get('audit');
          const targetUserId = c.req.param('userId');
          const { role } = c.req.valid('json');
          if (!UUID_RE.test(targetUserId)) return c.json({ error: 'member_not_found' }, 404);

          const [target] = await tx
            .select({ role: memberships.role })
            .from(memberships)
            .where(and(eq(memberships.accountId, accountId), eq(memberships.userId, targetUserId)))
            .limit(1);
          if (!target) return c.json({ error: 'member_not_found' }, 404);
          if (target.role === 'owner') return c.json({ error: 'cannot_change_owner' }, 403);

          if (target.role !== role) {
            await tx
              .update(memberships)
              .set({ role, updatedAt: new Date() })
              .where(
                and(eq(memberships.accountId, accountId), eq(memberships.userId, targetUserId)),
              );
            await audit({
              entityType: 'membership',
              entityId: targetUserId,
              action: 'update',
              before: { userId: targetUserId, role: target.role },
              after: { userId: targetUserId, role },
            });
          }

          return c.json({ ok: true, role });
        },
      )
      // Transfer workspace ownership to another member. workspace:manage gated,
      // which only the owner holds — so the caller is the current owner. Demote
      // the owner to admin BEFORE promoting the target so the one-owner-per-
      // account partial unique index never sees two owners mid-transaction.
      .post(
        '/api/team/:userId/transfer-ownership',
        requireCapability('workspace:manage'),
        async (c) => {
          const tx = c.get('tx');
          const accountId = c.get('accountId');
          const audit = c.get('audit');
          const currentUserId = c.get('userId');
          const targetUserId = c.req.param('userId');
          if (!UUID_RE.test(targetUserId)) return c.json({ error: 'member_not_found' }, 404);
          if (targetUserId === currentUserId) return c.json({ error: 'already_owner' }, 400);

          const [target] = await tx
            .select({ role: memberships.role })
            .from(memberships)
            .where(and(eq(memberships.accountId, accountId), eq(memberships.userId, targetUserId)))
            .limit(1);
          if (!target) return c.json({ error: 'member_not_found' }, 404);

          const now = new Date();
          await tx
            .update(memberships)
            .set({ role: 'admin', updatedAt: now })
            .where(
              and(eq(memberships.accountId, accountId), eq(memberships.userId, currentUserId)),
            );
          await tx
            .update(memberships)
            .set({ role: 'owner', updatedAt: now })
            .where(and(eq(memberships.accountId, accountId), eq(memberships.userId, targetUserId)));

          await audit({
            entityType: 'membership',
            entityId: targetUserId,
            action: 'transfer-ownership',
            before: { ownerUserId: currentUserId, previousTargetRole: target.role },
            after: { ownerUserId: targetUserId, demotedToAdmin: currentUserId },
          });

          return c.json({ ok: true });
        },
      )
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
            businessEmail: companies.businessEmail,
            replyToEmail: companies.replyToEmail,
            showAddressOnInvoice: companies.showAddressOnInvoice,
            showPhoneOnInvoice: companies.showPhoneOnInvoice,
            showEmailOnInvoice: companies.showEmailOnInvoice,
            showAddressOnEstimate: companies.showAddressOnEstimate,
            showPhoneOnEstimate: companies.showPhoneOnEstimate,
            showEmailOnEstimate: companies.showEmailOnEstimate,
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
      // POST company — add another business to the workspace. The first company
      // is seeded at signup; this is the multi-company create path. Gated by
      // settings:manage (owner + admin) — same reach as editing a company's
      // profile. Name + type are required so the new company never trips the
      // first-run gate; the sole-prop COA is seeded in the same tx so the ledger
      // can post immediately.
      .post(
        '/api/companies',
        requireCapability('settings:manage'),
        validator('json', (value, c) => {
          const parsed = companyCreateSchema.safeParse(value);
          if (!parsed.success) {
            return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
          }
          return parsed.data;
        }),
        async (c) => {
          const { name, businessType } = c.req.valid('json');
          const tx = c.get('tx');
          const accountId = c.get('accountId');

          const id = uuidv7();
          const [created] = await tx
            .insert(companies)
            .values({ id, accountId, name, businessType })
            .returning();
          if (!created) return c.json({ error: 'create_failed' }, 500);
          await seedChartOfAccounts(tx, { accountId, companyId: id });

          await c.var.audit({
            entityType: 'company',
            entityId: id,
            action: 'create',
            after: { name, businessType },
            companyId: id,
          });

          // Telemetry (opt-in; no-op unless the account enabled it). Only the
          // explicit multi-company create counts; the signup-seeded first
          // company predates any opt-in so it never reaches here.
          await emit(tx, { name: 'company_created' });

          // Same projection as GET /api/companies rows, so the web can switch to
          // the new company and slot it into the list without a refetch.
          return c.json(
            {
              id: created.id,
              name: created.name,
              businessType: created.businessType,
              businessAddress: created.businessAddress,
              businessPhone: created.businessPhone,
              businessEmail: created.businessEmail,
              replyToEmail: created.replyToEmail,
              showAddressOnInvoice: created.showAddressOnInvoice,
              showPhoneOnInvoice: created.showPhoneOnInvoice,
              showEmailOnInvoice: created.showEmailOnInvoice,
              showAddressOnEstimate: created.showAddressOnEstimate,
              showPhoneOnEstimate: created.showPhoneOnEstimate,
              showEmailOnEstimate: created.showEmailOnEstimate,
              ...paymentMethodsView(created),
            },
            201,
          );
        },
      )
      // PATCH company — slice L3. Sparse semantics: only the keys present in
      // the body get written. Used by the post-signup business-type wizard
      // (sends { businessType, name? }) and any future rename surface from
      // settings. validator middleware lifts the json body into the typed
      // Input so hc<AppType>() sees `{ param, json }` on .$patch (same shape
      // as the customer/invoice PATCHes).
      .patch(
        '/api/companies/:id',
        requireCapability('settings:manage'),
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
          if (data.businessEmail !== undefined) patch.businessEmail = data.businessEmail;
          // Per-field invoice-display defaults — plain booleans, sparse.
          if (data.showAddressOnInvoice !== undefined)
            patch.showAddressOnInvoice = data.showAddressOnInvoice;
          if (data.showPhoneOnInvoice !== undefined)
            patch.showPhoneOnInvoice = data.showPhoneOnInvoice;
          if (data.showEmailOnInvoice !== undefined)
            patch.showEmailOnInvoice = data.showEmailOnInvoice;
          if (data.showAddressOnEstimate !== undefined)
            patch.showAddressOnEstimate = data.showAddressOnEstimate;
          if (data.showPhoneOnEstimate !== undefined)
            patch.showPhoneOnEstimate = data.showPhoneOnEstimate;
          if (data.showEmailOnEstimate !== undefined)
            patch.showEmailOnEstimate = data.showEmailOnEstimate;
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
              businessEmail: before.businessEmail,
              replyToEmail: before.replyToEmail,
              showAddressOnInvoice: before.showAddressOnInvoice,
              showPhoneOnInvoice: before.showPhoneOnInvoice,
              showEmailOnInvoice: before.showEmailOnInvoice,
              showAddressOnEstimate: before.showAddressOnEstimate,
              showPhoneOnEstimate: before.showPhoneOnEstimate,
              showEmailOnEstimate: before.showEmailOnEstimate,
              ...paymentMethodsView(before),
            },
            after: {
              name: after.name,
              businessType: after.businessType,
              businessAddress: after.businessAddress,
              businessPhone: after.businessPhone,
              businessEmail: after.businessEmail,
              replyToEmail: after.replyToEmail,
              showAddressOnInvoice: after.showAddressOnInvoice,
              showPhoneOnInvoice: after.showPhoneOnInvoice,
              showEmailOnInvoice: after.showEmailOnInvoice,
              showAddressOnEstimate: after.showAddressOnEstimate,
              showPhoneOnEstimate: after.showPhoneOnEstimate,
              showEmailOnEstimate: after.showEmailOnEstimate,
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
            businessEmail: after.businessEmail,
            replyToEmail: after.replyToEmail,
            showAddressOnInvoice: after.showAddressOnInvoice,
            showPhoneOnInvoice: after.showPhoneOnInvoice,
            showEmailOnInvoice: after.showEmailOnInvoice,
            showAddressOnEstimate: after.showAddressOnEstimate,
            showPhoneOnEstimate: after.showPhoneOnEstimate,
            showEmailOnEstimate: after.showEmailOnEstimate,
            ...paymentMethodsView(after),
          });
        },
      )
      // ---- Per-company email templates ------------------------------------
      // The customer-facing emails (invoice/estimate/statement) a business can
      // customize. An override row exists only when customized; otherwise the
      // in-code default (DEFAULT_TEMPLATES) is returned + sent. Editable surface
      // is subject + body prose with {{placeholders}}; the HTML chrome stays
      // ours. GET is ungated (a read); writes are settings:manage.
      .get('/api/companies/:id/email-templates', async (c) => {
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

        const overrides = await tx
          .select({
            type: emailTemplates.type,
            subject: emailTemplates.subject,
            body: emailTemplates.body,
            updatedAt: emailTemplates.updatedAt,
          })
          .from(emailTemplates)
          .where(and(eq(emailTemplates.companyId, id), eq(emailTemplates.accountId, accountId)));
        const byType = new Map(overrides.map((o) => [o.type, o]));

        const templates = EMAIL_TEMPLATE_TYPES.map((type) => {
          const override = byType.get(type);
          const def = DEFAULT_TEMPLATES[type];
          return {
            type,
            subject: override?.subject ?? def.subject,
            body: override?.body ?? def.body,
            isCustomized: Boolean(override),
            updatedAt: override?.updatedAt ?? null,
            placeholders: EMAIL_TEMPLATE_PLACEHOLDERS[type],
            defaultTemplate: def,
          };
        });
        return c.json({ templates });
      })
      .put(
        '/api/companies/:id/email-templates/:type',
        requireCapability('settings:manage'),
        validator('json', (value, c) => {
          const parsed = emailTemplateUpdateSchema.safeParse(value);
          if (!parsed.success) {
            return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
          }
          return parsed.data;
        }),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
          const typeParsed = emailTemplateTypeSchema.safeParse(c.req.param('type'));
          if (!typeParsed.success) return c.json({ error: 'invalid_type' }, 400);
          const type = typeParsed.data;
          const { subject, body } = c.req.valid('json');

          // Reject any {{token}} not valid for this type so a typo never ships
          // as literal text to a customer (the editor validates the same way).
          const bad = unknownPlaceholders(type, subject, body);
          if (bad.length) return c.json({ error: 'unknown_placeholders', placeholders: bad }, 400);

          const tx = c.get('tx');
          const accountId = c.get('accountId');

          const [company] = await tx
            .select({ id: companies.id })
            .from(companies)
            .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
            .limit(1);
          if (!company) return c.json({ error: 'company_not_found' }, 404);

          const [before] = await tx
            .select({ subject: emailTemplates.subject, body: emailTemplates.body })
            .from(emailTemplates)
            .where(
              and(
                eq(emailTemplates.companyId, id),
                eq(emailTemplates.accountId, accountId),
                eq(emailTemplates.type, type),
              ),
            )
            .limit(1);

          const now = new Date();
          const [after] = await tx
            .insert(emailTemplates)
            .values({
              id: uuidv7(),
              accountId,
              companyId: id,
              type,
              subject,
              body,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: [emailTemplates.companyId, emailTemplates.type],
              set: { subject, body, updatedAt: now },
            })
            .returning({
              subject: emailTemplates.subject,
              body: emailTemplates.body,
              updatedAt: emailTemplates.updatedAt,
            });
          if (!after) return c.json({ error: 'email_template_write_failed' }, 500);

          await c.var.audit({
            entityType: 'email-template',
            entityId: id,
            action: before ? 'update' : 'create',
            before: before ? { type, subject: before.subject, body: before.body } : { type },
            after: { type, subject: after.subject, body: after.body },
            companyId: id,
          });

          return c.json({
            type,
            subject: after.subject,
            body: after.body,
            isCustomized: true,
            updatedAt: after.updatedAt,
            placeholders: EMAIL_TEMPLATE_PLACEHOLDERS[type],
            defaultTemplate: DEFAULT_TEMPLATES[type],
          });
        },
      )
      // Reset to default = drop the override row. Idempotent: resetting an
      // already-default template is a 200 no-op echoing the default back.
      .delete(
        '/api/companies/:id/email-templates/:type',
        requireCapability('settings:manage'),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
          const typeParsed = emailTemplateTypeSchema.safeParse(c.req.param('type'));
          if (!typeParsed.success) return c.json({ error: 'invalid_type' }, 400);
          const type = typeParsed.data;
          const tx = c.get('tx');
          const accountId = c.get('accountId');

          const [deleted] = await tx
            .delete(emailTemplates)
            .where(
              and(
                eq(emailTemplates.companyId, id),
                eq(emailTemplates.accountId, accountId),
                eq(emailTemplates.type, type),
              ),
            )
            .returning({ subject: emailTemplates.subject, body: emailTemplates.body });

          if (deleted) {
            await c.var.audit({
              entityType: 'email-template',
              entityId: id,
              action: 'reset',
              before: { type, subject: deleted.subject, body: deleted.body },
              after: { type },
              companyId: id,
            });
          }

          const def = DEFAULT_TEMPLATES[type];
          return c.json({
            type,
            subject: def.subject,
            body: def.body,
            isCustomized: false,
            updatedAt: null,
            placeholders: EMAIL_TEMPLATE_PLACEHOLDERS[type],
            defaultTemplate: def,
          });
        },
      )
      // Render a candidate (unsaved) template against sample data with the real
      // builders, so the editor preview is exactly what a customer receives.
      .post(
        '/api/companies/:id/email-templates/:type/preview',
        requireCapability('settings:manage'),
        validator('json', (value, c) => {
          const parsed = emailTemplateUpdateSchema.safeParse(value);
          if (!parsed.success) {
            return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
          }
          return parsed.data;
        }),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
          const typeParsed = emailTemplateTypeSchema.safeParse(c.req.param('type'));
          if (!typeParsed.success) return c.json({ error: 'invalid_type' }, 400);
          const type = typeParsed.data;
          const { subject, body } = c.req.valid('json');
          const bad = unknownPlaceholders(type, subject, body);
          if (bad.length) return c.json({ error: 'unknown_placeholders', placeholders: bad }, 400);

          const tx = c.get('tx');
          const accountId = c.get('accountId');
          const [company] = await tx
            .select({ name: companies.name })
            .from(companies)
            .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
            .limit(1);
          if (!company) return c.json({ error: 'company_not_found' }, 404);

          return c.json(
            buildEmailPreview(
              type,
              { subject, body },
              company.name ?? 'Your business',
              deps.publicAppUrl,
            ),
          );
        },
      )
      // ---- Company logo (shown on invoices) -------------------------------
      // Same upload/serve/delete shape as the expense receipt: multipart in,
      // a time-limited signed URL out, object write/delete as the LAST await so
      // a storage failure rolls the column change back. Raster-only, ≤2MB.
      .post('/api/companies/:id/logo', requireCapability('settings:manage'), async (c) => {
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
      .delete('/api/companies/:id/logo', requireCapability('settings:manage'), async (c) => {
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
      .post(
        '/api/companies/:id/stripe-connect/onboard',
        requireCapability('settings:manage'),
        async (c) => {
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
        },
      )
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
      .get('/api/companies/:id/ledger/export', requireCapability('reports:export'), async (c) => {
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
          // `owing` completes the in/out/owed/owing quadrant — the live AP
          // balance (what's owed to vendors via open bills), point-in-time like
          // `owed`. Zero until the first bill is recorded.
          const owing = await apBalance(tx, { accountId, companyId: id });

          // Inclusive display window (the day before the half-open upper bound).
          const toInclusive = new Date(toExclusive);
          toInclusive.setUTCDate(toInclusive.getUTCDate() - 1);
          const ymd = (dt: Date) => dt.toISOString().slice(0, 10);

          return c.json({
            moneyIn: cash.moneyIn,
            moneyOut: cash.moneyOut,
            owed,
            owing,
            from: ymd(fromDate),
            to: ymd(toInclusive),
          });
        },
      )
      // Top-products report (slice I5) — the payoff of the source_item_id
      // breadcrumb. A deterministic GROUP BY source_item_id aggregate over
      // invoice line items (SUM(amount), COUNT(*)); no second datastore. This
      // is a management/sales lens, explicitly NOT GL-reconciled: line amounts
      // are pre-tax, and a single "Uncatalogued / other" bucket (NULL-source
      // lines, identified by sourceItemId === null) collects hand-typed lines
      // so product rows + the bucket tie back to GL revenue on a matched basis.
      // `basis` states what counts: 'paid' (cash — paid invoices only, the
      // default) or 'sent' (sent or paid, voided/draft excluded). Archived
      // items keep their name via the left join, so the report never loses
      // history. Catalogued rows sort by revenue desc; the bucket sorts last.
      .get(
        '/api/companies/:id/top-products',
        // validator types `query` for the hc<AppType>() client (same reason as
        // the dashboard route) and rejects an unknown basis with a clean 400.
        validator('query', (v, c) => {
          const basis = v.basis;
          if (basis !== undefined && basis !== 'paid' && basis !== 'sent') {
            return c.json({ error: 'invalid_basis' }, 400);
          }
          return { basis: (basis ?? 'paid') as 'paid' | 'sent' };
        }),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);

          const { basis } = c.req.valid('query');

          const tx = c.get('tx');
          const accountId = c.get('accountId');

          const [company] = await tx
            .select({ id: companies.id })
            .from(companies)
            .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
            .limit(1);
          if (!company) return c.json({ error: 'company_not_found' }, 404);

          const statusFilter =
            basis === 'paid'
              ? eq(invoices.status, 'paid')
              : inArray(invoices.status, ['sent', 'paid']);

          const rows = await tx
            .select({
              sourceItemId: invoiceLineItems.sourceItemId,
              name: items.name,
              revenue: sql<string>`sum(${invoiceLineItems.amount})::numeric(15,2)`,
              lineCount: sql<number>`count(*)::int`,
            })
            .from(invoiceLineItems)
            .innerJoin(invoices, eq(invoices.id, invoiceLineItems.invoiceId))
            .leftJoin(items, eq(items.id, invoiceLineItems.sourceItemId))
            .where(
              and(
                eq(invoiceLineItems.accountId, accountId),
                eq(invoices.accountId, accountId),
                eq(invoices.companyId, id),
                statusFilter,
              ),
            )
            .groupBy(invoiceLineItems.sourceItemId, items.name)
            // Uncatalogued bucket (null source) sorts last; products by revenue.
            .orderBy(
              sql`(${invoiceLineItems.sourceItemId} is null) asc, sum(${invoiceLineItems.amount}) desc`,
            );

          const mapped = rows.map((r) => ({
            sourceItemId: r.sourceItemId,
            name: r.name,
            revenue: r.revenue ?? '0.00',
            lineCount: r.lineCount,
          }));
          // Top 25 catalogued products by revenue, plus the single
          // "Uncatalogued / other" bucket (hand-typed lines) appended as
          // context — it's an "other" row, not a product, so it doesn't consume
          // a slot in the top 25. Slicing in app code (rows are already ordered
          // products-first, bucket-last) keeps the bucket regardless of how many
          // products there are; a bare LIMIT would drop it.
          const TOP_N = 25;
          const products = mapped.filter((p) => p.sourceItemId !== null).slice(0, TOP_N);
          const bucket = mapped.filter((p) => p.sourceItemId === null);
          return c.json({ basis, products: [...products, ...bucket] });
        },
      )
      // Profit & Loss report (the tax set). Accrual income statement read
      // straight off the GL: revenue + expense accounts, summed in their
      // normal-balance direction over a [from, to] window (inclusive, to+1 day
      // exclusive on the upper bound — same convention as the ledger export and
      // dashboard). Default window is year-to-date. Each account's signed net
      // (per-account window sum) is reversal-safe by construction: a void/edit
      // posts a reversing entry that flips the sign, so an in-window correction
      // nets out and a cross-period one lands in the period it was posted (real
      // accrual behavior) — no per-source netting like cashFlowNet needs.
      // taxMapping (Schedule C line) rides along so the expense breakdown
      // doubles as a tax-prep view. Powers both /reports/profit-and-loss and
      // /reports/expenses-by-category (the expense section).
      .get(
        '/api/companies/:id/profit-loss',
        validator('query', (v) => ({
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

          const { from: fromRaw, to: toRaw } = c.req.valid('query');
          const win = parseReportWindow(fromRaw, toRaw);
          if ('error' in win) return c.json({ error: win.error }, 400);
          const { fromDate, toExclusive, from, to } = win;

          // Per-account net in the account's normal-balance direction: when a
          // line's side matches the account's normal_balance it adds, else it
          // subtracts. Revenue (credit-normal) => credit−debit; expense
          // (debit-normal) => debit−credit.
          const rows = await tx
            .select({
              code: chartOfAccounts.code,
              name: chartOfAccounts.name,
              accountType: chartOfAccounts.accountType,
              taxMapping: chartOfAccounts.taxMapping,
              amount: sql<string>`sum(case when ${journalLines.side} = ${chartOfAccounts.normalBalance} then ${journalLines.amount} else -${journalLines.amount} end)::numeric(15,2)`,
            })
            .from(journalLines)
            .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
            .innerJoin(chartOfAccounts, eq(journalLines.coaAccountId, chartOfAccounts.id))
            .where(
              and(
                eq(journalEntries.companyId, id),
                eq(journalEntries.accountId, accountId),
                inArray(chartOfAccounts.accountType, ['revenue', 'expense']),
                gte(journalEntries.postedAt, fromDate),
                lt(journalEntries.postedAt, toExclusive),
              ),
            )
            .groupBy(
              chartOfAccounts.code,
              chartOfAccounts.name,
              chartOfAccounts.accountType,
              chartOfAccounts.taxMapping,
            )
            .orderBy(asc(chartOfAccounts.code));

          type Line = { code: string; name: string; taxMapping: string | null; amount: string };
          const revenue: Line[] = [];
          const expenses: Line[] = [];
          let totalRevenue = 0;
          let totalExpenses = 0;
          for (const r of rows) {
            const amt = Number(r.amount);
            // Drop accounts that net to zero in the window (e.g. a sale fully
            // voided in-period) so the statement isn't cluttered with no-ops.
            if (amt === 0) continue;
            const line: Line = {
              code: r.code,
              name: r.name,
              taxMapping: r.taxMapping,
              amount: r.amount,
            };
            if (r.accountType === 'revenue') {
              revenue.push(line);
              totalRevenue += amt;
            } else {
              expenses.push(line);
              totalExpenses += amt;
            }
          }

          return c.json({
            from,
            to,
            revenue,
            expenses,
            totalRevenue: totalRevenue.toFixed(2),
            totalExpenses: totalExpenses.toFixed(2),
            netProfit: (totalRevenue - totalExpenses).toFixed(2),
          });
        },
      )
      // Sales by customer (insight set). Pre-tax sales (subtotal) per customer
      // for invoices issued in the window, sent or paid (drafts + voided
      // excluded). Top 25 by sales; the grand total sums ALL contacts (computed
      // from the full result, sliced in app code) so "Top 25 of $X" is honest.
      .get(
        '/api/companies/:id/sales-by-customer',
        validator('query', (v) => ({
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

          const { from: fromRaw, to: toRaw } = c.req.valid('query');
          const win = parseReportWindow(fromRaw, toRaw);
          if ('error' in win) return c.json({ error: win.error }, 400);

          const rows = await tx
            .select({
              contactId: invoices.contactId,
              name: contacts.name,
              sales: sql<string>`sum(${invoices.subtotal})::numeric(15,2)`,
              invoiceCount: sql<number>`count(*)::int`,
            })
            .from(invoices)
            .leftJoin(contacts, eq(contacts.id, invoices.contactId))
            .where(
              and(
                eq(invoices.accountId, accountId),
                eq(invoices.companyId, id),
                inArray(invoices.status, ['sent', 'paid']),
                gte(invoices.issueDate, win.from),
                lte(invoices.issueDate, win.to),
              ),
            )
            .groupBy(invoices.contactId, contacts.name)
            .orderBy(sql`sum(${invoices.subtotal}) desc`);

          const totalSales = rows.reduce((s, r) => s + Number(r.sales), 0).toFixed(2);
          return c.json({
            from: win.from,
            to: win.to,
            contacts: rows.slice(0, 25).map((r) => ({
              contactId: r.contactId,
              name: r.name,
              sales: r.sales ?? '0.00',
              invoiceCount: r.invoiceCount,
            })),
            totalSales,
          });
        },
      )
      // Revenue over time (insight set). Pre-tax sales per calendar month for
      // invoices issued in the window, sent or paid. Months with no sales are
      // simply absent (the web page fills the gaps for a continuous trend).
      .get(
        '/api/companies/:id/revenue-over-time',
        validator('query', (v) => ({
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

          const { from: fromRaw, to: toRaw } = c.req.valid('query');
          const win = parseReportWindow(fromRaw, toRaw);
          if ('error' in win) return c.json({ error: win.error }, 400);

          const monthExpr = sql<string>`to_char(date_trunc('month', ${invoices.issueDate}::date), 'YYYY-MM')`;
          const rows = await tx
            .select({
              month: monthExpr,
              revenue: sql<string>`sum(${invoices.subtotal})::numeric(15,2)`,
            })
            .from(invoices)
            .where(
              and(
                eq(invoices.accountId, accountId),
                eq(invoices.companyId, id),
                inArray(invoices.status, ['sent', 'paid']),
                gte(invoices.issueDate, win.from),
                lte(invoices.issueDate, win.to),
              ),
            )
            .groupBy(monthExpr)
            .orderBy(monthExpr);

          const total = rows.reduce((s, r) => s + Number(r.revenue), 0).toFixed(2);
          return c.json({
            from: win.from,
            to: win.to,
            months: rows.map((r) => ({ month: r.month, revenue: r.revenue ?? '0.00' })),
            total,
          });
        },
      )
      // Estimate win rate (insight set). Estimate counts + pre-tax value grouped
      // by status for estimates issued in the window. Win rate = accepted /
      // (accepted + declined + expired) by count — "decided" excludes still-open
      // draft/sent. Null when nothing has been decided yet.
      .get(
        '/api/companies/:id/estimate-win-rate',
        validator('query', (v) => ({
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

          const { from: fromRaw, to: toRaw } = c.req.valid('query');
          const win = parseReportWindow(fromRaw, toRaw);
          if ('error' in win) return c.json({ error: win.error }, 400);

          const rows = await tx
            .select({
              status: estimates.status,
              count: sql<number>`count(*)::int`,
              value: sql<string>`sum(${estimates.subtotal})::numeric(15,2)`,
            })
            .from(estimates)
            .where(
              and(
                eq(estimates.accountId, accountId),
                eq(estimates.companyId, id),
                gte(estimates.issueDate, win.from),
                lte(estimates.issueDate, win.to),
              ),
            )
            .groupBy(estimates.status);

          // Normalize to a fixed status set (zeros for absent statuses) so the
          // page renders consistently.
          const STATUSES = ['draft', 'sent', 'accepted', 'declined', 'expired'] as const;
          const byCode = new Map(rows.map((r) => [r.status, r]));
          const byStatus = STATUSES.map((status) => {
            const row = byCode.get(status);
            return { status, count: row?.count ?? 0, value: row?.value ?? '0.00' };
          });
          const countFor = (s: string) => byStatus.find((b) => b.status === s)?.count ?? 0;
          const accepted = countFor('accepted');
          const decided = accepted + countFor('declined') + countFor('expired');
          return c.json({
            from: win.from,
            to: win.to,
            byStatus,
            acceptedCount: accepted,
            decidedCount: decided,
            // 4-dp ratio (e.g. "0.6667"); null when nothing decided yet.
            winRate: decided > 0 ? (accepted / decided).toFixed(4) : null,
          });
        },
      )
      // Balance sheet (the other primary financial statement, paired with P&L).
      // Point-in-time: every account's signed balance as of a date. The books
      // are never closed, so revenue − expenses through the as-of date is folded
      // into equity as a "Retained earnings" line — that's what makes
      // Assets = Liabilities + Equity hold (it follows directly from the trial
      // balance always balancing: Assets+Expenses = Liabilities+Equity+Revenue).
      .get(
        '/api/companies/:id/balance-sheet',
        validator('query', (v) => ({ asOf: typeof v.asOf === 'string' ? v.asOf : undefined })),
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

          const parsed = parseAsOf(c.req.valid('query').asOf);
          if ('error' in parsed) return c.json({ error: parsed.error }, 400);
          const { asOf, asOfExclusive } = parsed;

          const rows = await tx
            .select({
              code: chartOfAccounts.code,
              name: chartOfAccounts.name,
              accountType: chartOfAccounts.accountType,
              amount: sql<string>`sum(case when ${journalLines.side} = ${chartOfAccounts.normalBalance} then ${journalLines.amount} else -${journalLines.amount} end)::numeric(15,2)`,
            })
            .from(journalLines)
            .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
            .innerJoin(chartOfAccounts, eq(journalLines.coaAccountId, chartOfAccounts.id))
            .where(
              and(
                eq(journalEntries.companyId, id),
                eq(journalEntries.accountId, accountId),
                lt(journalEntries.postedAt, asOfExclusive),
              ),
            )
            .groupBy(chartOfAccounts.code, chartOfAccounts.name, chartOfAccounts.accountType)
            .orderBy(asc(chartOfAccounts.code));

          type Line = { code: string; name: string; amount: string };
          const assets: Line[] = [];
          const liabilities: Line[] = [];
          const equity: Line[] = [];
          let totalAssets = 0;
          let totalLiabilities = 0;
          let equitySum = 0;
          let revenueSum = 0;
          let expenseSum = 0;
          for (const r of rows) {
            const amt = Number(r.amount);
            if (amt === 0) continue;
            const line: Line = { code: r.code, name: r.name, amount: r.amount };
            if (r.accountType === 'asset') {
              assets.push(line);
              totalAssets += amt;
            } else if (r.accountType === 'liability') {
              liabilities.push(line);
              totalLiabilities += amt;
            } else if (r.accountType === 'equity') {
              equity.push(line);
              equitySum += amt;
            } else if (r.accountType === 'revenue') {
              revenueSum += amt;
            } else {
              expenseSum += amt;
            }
          }
          // Net income (retained earnings while the books stay open) closes the
          // identity: Assets = Liabilities + (explicit equity + net income).
          const netIncome = revenueSum - expenseSum;
          const totalEquity = equitySum + netIncome;
          const totalLiabilitiesAndEquity = totalLiabilities + totalEquity;
          return c.json({
            asOf,
            assets,
            liabilities,
            equity,
            netIncome: netIncome.toFixed(2),
            totalAssets: totalAssets.toFixed(2),
            totalLiabilities: totalLiabilities.toFixed(2),
            totalEquity: totalEquity.toFixed(2),
            totalLiabilitiesAndEquity: totalLiabilitiesAndEquity.toFixed(2),
            // True by construction (every entry balances); surfaced as an
            // integrity check — a false here means the ledger has drifted.
            balanced: Math.abs(totalAssets - totalLiabilitiesAndEquity) < 0.005,
          });
        },
      )
      // A/R aging (getting-paid set). Currently-outstanding invoices (status
      // 'sent' — issued but unpaid; no partial payments in MVP, so the owed
      // amount is the invoice total) bucketed by days past due relative to the
      // as-of date. The total ties to the AR ledger balance.
      .get(
        '/api/companies/:id/ar-aging',
        validator('query', (v) => ({ asOf: typeof v.asOf === 'string' ? v.asOf : undefined })),
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

          const parsed = parseAsOf(c.req.valid('query').asOf);
          if ('error' in parsed) return c.json({ error: parsed.error }, 400);
          const { asOf } = parsed;

          const rows = await tx
            .select({
              id: invoices.id,
              number: invoices.number,
              customerName: contacts.name,
              dueDate: invoices.dueDate,
              total: invoices.total,
            })
            .from(invoices)
            .leftJoin(contacts, eq(contacts.id, invoices.contactId))
            .where(
              and(
                eq(invoices.accountId, accountId),
                eq(invoices.companyId, id),
                eq(invoices.status, 'sent'),
              ),
            );

          // Days past due = asOf − dueDate (both bare dates, UTC midnight). A
          // negative value = not yet due → the "current" bucket.
          const asOfMs = new Date(`${asOf}T00:00:00Z`).getTime();
          const BUCKETS = [
            { key: 'current', label: 'Current', min: Number.NEGATIVE_INFINITY, max: 0 },
            { key: '1-30', label: '1–30 days', min: 1, max: 30 },
            { key: '31-60', label: '31–60 days', min: 31, max: 60 },
            { key: '61-90', label: '61–90 days', min: 61, max: 90 },
            { key: '90+', label: '90+ days', min: 91, max: Number.POSITIVE_INFINITY },
          ];
          const bucketTotals = new Map(BUCKETS.map((b) => [b.key, { count: 0, amount: 0 }]));
          const outstanding = rows
            .map((r) => {
              const dueMs = new Date(`${r.dueDate}T00:00:00Z`).getTime();
              const daysPastDue = Math.round((asOfMs - dueMs) / 86_400_000);
              const bucket = BUCKETS.find((b) => daysPastDue >= b.min && daysPastDue <= b.max);
              const key = bucket?.key ?? 'current';
              const agg = bucketTotals.get(key);
              if (agg) {
                agg.count += 1;
                agg.amount += Number(r.total);
              }
              return {
                id: r.id,
                number: r.number,
                customerName: r.customerName,
                dueDate: r.dueDate,
                daysPastDue,
                amount: r.total,
              };
            })
            // Most overdue first.
            .sort((a, b) => b.daysPastDue - a.daysPastDue);

          const total = outstanding.reduce((s, r) => s + Number(r.amount), 0).toFixed(2);
          return c.json({
            asOf,
            buckets: BUCKETS.map((b) => {
              const agg = bucketTotals.get(b.key);
              return {
                key: b.key,
                label: b.label,
                count: agg?.count ?? 0,
                amount: (agg?.amount ?? 0).toFixed(2),
              };
            }),
            invoices: outstanding,
            total,
          });
        },
      )
      // Sales tax collected (getting-paid set). Net movement on Sales Tax
      // Payable (COA 2200, per SOLE_PROP_COA) over the window — sent invoices
      // credit it, voids debit it, so credit−debit is tax owed to the state for
      // the period. Bucketed by the month the posting landed (mark-sent time).
      .get(
        '/api/companies/:id/sales-tax',
        validator('query', (v) => ({
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

          const { from: fromRaw, to: toRaw } = c.req.valid('query');
          const win = parseReportWindow(fromRaw, toRaw);
          if ('error' in win) return c.json({ error: win.error }, 400);

          const monthExpr = sql<string>`to_char(date_trunc('month', ${journalEntries.postedAt}), 'YYYY-MM')`;
          const rows = await tx
            .select({
              month: monthExpr,
              collected: sql<string>`sum(case when ${journalLines.side} = 'credit' then ${journalLines.amount} else -${journalLines.amount} end)::numeric(15,2)`,
            })
            .from(journalLines)
            .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
            .innerJoin(chartOfAccounts, eq(journalLines.coaAccountId, chartOfAccounts.id))
            .where(
              and(
                eq(journalEntries.companyId, id),
                eq(journalEntries.accountId, accountId),
                eq(chartOfAccounts.code, '2200'),
                gte(journalEntries.postedAt, win.fromDate),
                lt(journalEntries.postedAt, win.toExclusive),
              ),
            )
            .groupBy(monthExpr)
            .orderBy(monthExpr);

          const total = rows.reduce((s, r) => s + Number(r.collected), 0).toFixed(2);
          return c.json({
            from: win.from,
            to: win.to,
            months: rows.map((r) => ({ month: r.month, collected: r.collected ?? '0.00' })),
            total,
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
      .post('/api/expenses', requireCapability('expenses:write'), async (c) => {
        const body = await c.req.json().catch(() => null);
        const parsed = expenseCreateSchema.safeParse(body);
        if (!parsed.success) {
          return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
        }

        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const {
          companyId,
          customerContactId,
          vendorContactId,
          categoryAccountId,
          paymentAccountId,
          ...rest
        } = parsed.data;

        const [company] = await tx
          .select({ id: companies.id })
          .from(companies)
          .where(and(eq(companies.id, companyId), eq(companies.accountId, accountId)))
          .limit(1);
        if (!company) return c.json({ error: 'company_not_found' }, 404);

        // customerContactId is optional (carried for v1.x job-costing, not surfaced
        // in MVP). When present it must belong to this account AND match the
        // expense's company — the same invariant the invoice create enforces.
        if (customerContactId) {
          const [customer] = await tx
            .select({ id: contacts.id, companyId: contacts.companyId })
            .from(contacts)
            .where(and(eq(contacts.id, customerContactId), eq(contacts.accountId, accountId)))
            .limit(1);
          if (!customer) return c.json({ error: 'contact_not_found' }, 404);
          if (customer.companyId !== companyId) {
            return c.json({ error: 'customer_company_mismatch' }, 400);
          }
        }

        // vendorContactId is the optional buy-from link (same account+company
        // invariant). Linking resolves the single on-screen "Vendor" field:
        // merchant is mirrored from the contact's name (the always-present
        // display string) and the contact is marked is_vendor so it shows on
        // the buy-from side of the relationship. The needs-review flag is left
        // null (a linked expense needs no review).
        let merchant = rest.merchant;
        const vendor = await resolveVendorLink(tx, accountId, companyId, vendorContactId);
        if (vendor && 'error' in vendor) return c.json({ error: vendor.error }, vendor.status);
        if (vendor) merchant = vendor.name;

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
            customerContactId: customerContactId ?? null,
            vendorContactId: vendorContactId ?? null,
            categoryAccountId,
            paymentAccountId,
            amount: rest.amount,
            expenseDate: rest.expenseDate,
            merchant,
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
          expense: { id: expenseId, merchant, amount: rest.amount },
          categoryCode: category.code,
          paymentCode: payment.code,
          accountId,
          companyId,
          postedAt: expenseDateToPostedAt(rest.expenseDate),
        });

        // Telemetry (opt-in; no-op unless the account enabled it). Read off the
        // created row, not a literal — today receipts attach via a follow-up
        // /:id/receipt upload so this is ~always false, but it stays correct if
        // the create flow ever carries a receipt inline. No amounts (TELEMETRY.md).
        await emit(tx, {
          name: 'expense_logged',
          has_receipt_attached: !!created?.receiptStorageKey,
        });

        return c.json(created, 201);
      })
      // ---- Text expense categorization (AI) -----------------------------
      // Stateless suggestion for the new/edit expense form: given the typed
      // merchant (+ optional memo/amount) the fast model picks a category from
      // the company's expense COA. The user reviews + saves — the AI never
      // writes the ledger. Opt-in like /extract: 503 when no LLM is configured.
      // A literal path, so it never collides with the /api/expenses/:id routes.
      .post('/api/expenses/categorize', requireCapability('expenses:write'), async (c) => {
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
        const needsReview = c.req.query('needsReview');

        // from/to are inclusive YYYY-MM-DD bounds on expense_date. Validate the
        // shape so a malformed value returns a clean 400 rather than letting
        // Postgres throw "invalid input syntax for type date" → 500.
        if (from !== undefined && !ISO_DATE_RE.test(from)) {
          return c.json({ error: 'invalid_from' }, 400);
        }
        if (to !== undefined && !ISO_DATE_RE.test(to)) {
          return c.json({ error: 'invalid_to' }, 400);
        }

        const limit = parseLimit(c.req.query('limit'));
        if (limit === null) return c.json({ error: 'invalid_limit' }, 400);
        // expense_date is a date column (string), created_at a timestamp (Date).
        const keys = [
          { col: expenses.expenseDate },
          { col: expenses.createdAt, revive: (v: unknown) => new Date(v as string) },
          { col: expenses.id },
        ];
        const keyset = applyCursor(c.req.query('cursor'), keys, 'desc');
        if (keyset === 'invalid') return c.json({ error: 'invalid_cursor' }, 400);

        const conditions = [eq(expenses.accountId, accountId), isNull(expenses.deletedAt)];
        if (companyId) conditions.push(eq(expenses.companyId, companyId));
        if (from) conditions.push(gte(expenses.expenseDate, from));
        if (to) conditions.push(lte(expenses.expenseDate, to));
        if (categoryAccountId) conditions.push(eq(expenses.categoryAccountId, categoryAccountId));
        // "Needs review" filter: receipt-backed expenses whose vendor isn't
        // linked yet (backed by the partial index expenses_vendor_review_idx).
        if (needsReview === 'true') conditions.push(eq(expenses.vendorReview, 'needs_review'));
        // Merchant contains-search. escapeLike neutralises %/_ so a literal
        // "50%" search doesn't turn into a wildcard.
        if (q) conditions.push(ilike(expenses.merchant, `%${escapeLike(q)}%`));
        if (keyset) conditions.push(keyset);

        const rows = await tx
          .select()
          .from(expenses)
          .where(and(...conditions))
          .orderBy(keysetOrderBy(keys, 'desc'))
          .limit(limit + 1);
        const page = slicePage(rows, limit, (r) => [r.expenseDate, r.createdAt, r.id]);
        return c.json({ expenses: page.rows, nextCursor: page.nextCursor });
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
        requireCapability('expenses:write'),
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
            customerContactId:
              data.customerContactId !== undefined
                ? data.customerContactId
                : current.customerContactId,
            vendorContactId:
              data.vendorContactId !== undefined ? data.vendorContactId : current.vendorContactId,
            categoryAccountId: data.categoryAccountId ?? current.categoryAccountId,
            paymentAccountId: data.paymentAccountId ?? current.paymentAccountId,
            amount: data.amount ?? current.amount,
            expenseDate: data.expenseDate ?? current.expenseDate,
            merchant: data.merchant ?? current.merchant,
            memo: data.memo !== undefined ? data.memo : current.memo,
          };

          if (data.customerContactId !== undefined) {
            const [customer] = await tx
              .select({ id: contacts.id, companyId: contacts.companyId })
              .from(contacts)
              .where(
                and(eq(contacts.id, data.customerContactId), eq(contacts.accountId, accountId)),
              )
              .limit(1);
            if (!customer) return c.json({ error: 'contact_not_found' }, 404);
            if (customer.companyId !== current.companyId) {
              return c.json({ error: 'customer_company_mismatch' }, 400);
            }
          }

          // Vendor link: only (re)validated when the field is touched. Linking
          // mirrors the contact's name into merchant and clears the review flag;
          // an explicit unlink re-flags iff a receipt is attached (otherwise
          // there's nothing to review). When untouched, vendor_review is left
          // as-is so an edit to some other field never resurrects a dismissed
          // flag.
          let vendorReview = current.vendorReview;
          if (data.vendorContactId !== undefined) {
            const vendor = await resolveVendorLink(
              tx,
              accountId,
              current.companyId,
              data.vendorContactId,
            );
            if (vendor && 'error' in vendor) return c.json({ error: vendor.error }, vendor.status);
            if (vendor) {
              next.merchant = vendor.name;
              vendorReview = null;
            } else {
              vendorReview = current.receiptStorageKey ? 'needs_review' : null;
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
              customerContactId: next.customerContactId ?? null,
              vendorContactId: next.vendorContactId ?? null,
              categoryAccountId: next.categoryAccountId,
              paymentAccountId: next.paymentAccountId,
              amount: next.amount,
              expenseDate: next.expenseDate,
              merchant: next.merchant,
              memo: next.memo ?? null,
              vendorReview,
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
      .delete('/api/expenses/:id', requireCapability('expenses:write'), async (c) => {
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
      .post('/api/expenses/:id/receipt', requireCapability('expenses:write'), async (c) => {
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

        // Scan-and-forget review flag: a freshly-attached receipt with no vendor
        // link goes to the "Needs review" queue so a human can link/create/
        // dismiss the vendor later. A receipt on an already-linked expense needs
        // no review.
        const vendorReview = expense.vendorContactId ? null : 'needs_review';
        const [updated] = await tx
          .update(expenses)
          .set({ receiptStorageKey: key, receiptUploadedAt: now, vendorReview, updatedAt: now })
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
      // Dismiss the needs-review flag without linking a vendor — the one-off
      // "I'm not tracking this merchant as a contact" path. Clears the flag
      // (vendor_review → null); never creates a contact. Idempotent.
      .post('/api/expenses/:id/dismiss-review', requireCapability('expenses:write'), async (c) => {
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

        if (expense.vendorReview !== null) {
          const [updated] = await tx
            .update(expenses)
            .set({ vendorReview: null, updatedAt: new Date() })
            .where(and(eq(expenses.id, id), eq(expenses.accountId, accountId)))
            .returning();
          await c.var.audit({
            entityType: 'expense',
            entityId: id,
            action: 'dismiss-review',
            before: { vendorReview: expense.vendorReview },
            after: { vendorReview: null },
            companyId: expense.companyId,
          });
          return c.json(updated);
        }
        return c.json(expense);
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
      .delete('/api/expenses/:id/receipt', requireCapability('expenses:write'), async (c) => {
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
      .post('/api/expenses/:id/extract', requireCapability('expenses:write'), async (c) => {
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

// createApp wraps the main chain and mounts the per-domain sub-apps at runtime.
// Each sub-app is a self-contained chained Hono instance (see apps/api/src/routes/*).
// Mounting via .route() keeps each sub-app's schema OUT of AppType — the main
// chain's inferred type is already at the TS serialization ceiling (TS7056), and
// the whole point of the modular-sub-apps refactor is that no single combined
// type is ever materialized. Each domain's RPC types ride on its own XAppType
// (BillsAppType, ItemsAppType, TaxPoliciesAppType, …); the web/mobile clients
// compose them behind a unified facade so call sites stay api.<domain>.
export function createApp(deps: AppDeps) {
  const app = createMainApp(deps);
  app.route('/', billsRoutes());
  app.route('/', itemsRoutes());
  app.route('/', taxPoliciesRoutes());
  app.route('/', auditEventsRoutes());
  app.route('/', telemetryRoutes());
  // Deps-taking sub-apps: they close over `deps` (social providers list, address
  // provider, local-FS file serving, the mailer for document sends) rather than
  // the tenant tx, so they're constructed with deps here.
  app.route('/', socialProvidersRoutes(deps));
  app.route('/', locationsRoutes(deps));
  app.route('/', filesRoutes(deps));
  app.route('/', contactsRoutes(deps));
  app.route('/', invoicesRoutes(deps));
  app.route('/', recurringInvoicesRoutes(deps));
  app.route('/', estimatesRoutes(deps));
  return app;
}

export type AppType = ReturnType<typeof createMainApp>;
// Per-domain RPC surfaces — each kept out of AppType (see the mount in createApp).
// Web/mobile build a dedicated hc<XAppType>() client per domain.
export type BillsAppType = ReturnType<typeof billsRoutes>;
export type ItemsAppType = ReturnType<typeof itemsRoutes>;
export type TaxPoliciesAppType = ReturnType<typeof taxPoliciesRoutes>;
export type SocialProvidersAppType = ReturnType<typeof socialProvidersRoutes>;
export type LocationsAppType = ReturnType<typeof locationsRoutes>;
export type AuditEventsAppType = ReturnType<typeof auditEventsRoutes>;
export type TelemetryAppType = ReturnType<typeof telemetryRoutes>;
export type ContactsAppType = ReturnType<typeof contactsRoutes>;
export type InvoicesAppType = ReturnType<typeof invoicesRoutes>;
export type RecurringInvoicesAppType = ReturnType<typeof recurringInvoicesRoutes>;
export type EstimatesAppType = ReturnType<typeof estimatesRoutes>;
// filesRoutes has no XAppType export: GET /api/files/:token is served by a
// signed URL hit directly (img src / download), never via a typed hc client, so
// nothing consumes its type. It's still mounted in createApp like the rest.

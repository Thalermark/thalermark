import { randomBytes } from 'node:crypto';
import * as Sentry from '@sentry/node';
import type { CashFlowAdvisor, ExpenseCategorizer, ReceiptExtractor } from '@thalermark/ai';
import {
  type Database,
  SYSTEM_USER_ID,
  accounts,
  auditEvents,
  authUser,
  bills,
  chartOfAccounts,
  companies,
  contacts,
  estimateLineItems,
  estimates,
  invitations,
  invoiceLineItems,
  invoices,
  memberships,
} from '@thalermark/db';
import type { AddressAutocompleteProvider } from '@thalermark/location';
import { getLogger } from '@thalermark/logger';
import type { StorageProvider } from '@thalermark/storage';
import { disableTelemetry, enableTelemetry, isTelemetryDisabled } from '@thalermark/telemetry';
import {
  billCreateSchema,
  billMarkPaidSchema,
  billUpdateSchema,
  can,
  inviteRoleSchema,
  telemetryUpdateSchema,
} from '@thalermark/validation';
import { and, asc, desc, eq, getTableColumns, gt, inArray, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { validator } from 'hono/validator';
import { v7 as uuidv7 } from 'uuid';
import type { ApiAuth } from './lib/auth.js';
import { emailFooterText, renderEmailHtml } from './lib/email-layout.js';
import {
  postBillOpen,
  postBillOpenReversal,
  postBillPayment,
  postInvoiceTransition,
} from './lib/ledger.js';
import type { Mailer } from './lib/mailer.js';
import { applyCursor, keysetOrderBy, parseLimit, slicePage } from './lib/pagination.js';
import {
  EMAIL_RE,
  UUID_RE,
  expenseDateToPostedAt,
  resolveCoaAccounts,
  resolveVendorLink,
} from './lib/route-helpers.js';
import { type StripeBundle, decimalDollarsToCents } from './lib/stripe.js';
import { requireCapability } from './middleware/authz.js';
import { type RlsVariables, rlsContext } from './middleware/rls-context.js';
import { auditEventsRoutes } from './routes/audit-events.js';
import { companiesRoutes } from './routes/companies.js';
import { contactsRoutes } from './routes/contacts.js';
import { estimatesRoutes } from './routes/estimates.js';
import { expensesRoutes } from './routes/expenses.js';
import { filesRoutes } from './routes/files.js';
import { invoicesRoutes } from './routes/invoices.js';
import { itemsRoutes } from './routes/items.js';
import { locationsRoutes } from './routes/locations.js';
import { recurringInvoicesRoutes } from './routes/recurring.js';
import { reportsRoutes } from './routes/reports.js';
import { socialProvidersRoutes } from './routes/social-providers.js';
import { taxPoliciesRoutes } from './routes/tax-policies.js';
import { telemetryRoutes } from './routes/telemetry.js';

const log = getLogger(['api', 'app']);

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
  app.route('/', companiesRoutes(deps));
  app.route('/', contactsRoutes(deps));
  app.route('/', expensesRoutes(deps));
  app.route('/', invoicesRoutes(deps));
  app.route('/', recurringInvoicesRoutes(deps));
  app.route('/', estimatesRoutes(deps));
  app.route('/', reportsRoutes(deps));
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
export type CompaniesAppType = ReturnType<typeof companiesRoutes>;
export type ContactsAppType = ReturnType<typeof contactsRoutes>;
export type ExpensesAppType = ReturnType<typeof expensesRoutes>;
export type InvoicesAppType = ReturnType<typeof invoicesRoutes>;
export type RecurringInvoicesAppType = ReturnType<typeof recurringInvoicesRoutes>;
export type EstimatesAppType = ReturnType<typeof estimatesRoutes>;
export type ReportsAppType = ReturnType<typeof reportsRoutes>;
// filesRoutes has no XAppType export: GET /api/files/:token is served by a
// signed URL hit directly (img src / download), never via a typed hc client, so
// nothing consumes its type. It's still mounted in createApp like the rest.

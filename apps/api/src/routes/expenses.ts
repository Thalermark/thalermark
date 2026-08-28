import {
  type ExtractionResult,
  createExpenseCategorizer,
  createReceiptExtractor,
} from '@thalermark/ai';
import {
  chartOfAccounts,
  companies,
  contacts,
  expenseAllocations,
  expenses,
  invoices,
  jobs,
} from '@thalermark/db';
import { emit } from '@thalermark/telemetry';
import {
  expenseAllocationsSchema,
  expenseCategorizeSchema,
  expenseCreateSchema,
  expenseUpdateSchema,
} from '@thalermark/validation';
import { and, asc, eq, gte, ilike, inArray, isNotNull, isNull, lte } from 'drizzle-orm';
import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { v7 as uuidv7 } from 'uuid';
import type { AppDeps } from '../app.js';
import { postExpenseCreate, postExpenseReversal } from '../lib/ledger.js';
import { recordLlmCallHealth } from '../lib/llm-connection.js';
import { resolveAccountCredential } from '../lib/llm-credentials.js';
import { applyCursor, keysetOrderBy, parseLimit, slicePage } from '../lib/pagination.js';
import {
  UUID_RE,
  escapeLike,
  expenseDateToPostedAt,
  mimeForKey,
  receiptFilename,
  resolveCoaAccounts,
  resolveVendorLink,
} from '../lib/route-helpers.js';
import { requireCapability } from '../middleware/authz.js';
import { requireEntitlement } from '../middleware/entitlement.js';
import { RATE_LIMITS, rateLimit } from '../middleware/rate-limit.js';
import type { RlsVariables } from '../middleware/rls-context.js';

// expenses — the expense domain (slice 8.9c): the third MVP entity chain,
// ledger-aware from day one. CRUD (create / list / get / edit / soft-delete),
// the AI text-categorization suggestion, receipt capture + signed download +
// delete (slice 8.9g), and vision-LLM receipt extraction (slice 8.9h). A
// deps-taking sub-app: /categorize closes over deps.categorizer, the receipt
// routes over deps.storage, /extract over deps.storage + deps.extractor.
//
// Every mutation wraps the row write + audit row + journal posting in the same
// tenant tx (c.get('tx')) so the deferred sum-to-zero trigger on journal_lines
// fires at commit and a posting failure rolls the whole mutation back together
// — the shape L2 established for invoice transitions. Create posts
// Dr <category> / Cr <payment>; edit posts a reversal of the prior entry + a
// fresh entry; delete is soft (deleted_at) and posts a reversal only.
// category_account_id must be an 'expense' COA row, payment_account_id an
// 'asset' row (the FK columns alone admit any account, so the API type-checks
// before posting). Mounted on createApp via .route() so its schema rides on its
// own ExpensesAppType instead of bloating AppType past TS7056. Route order is
// load-bearing: the literal /categorize is declared before the /:id routes so
// Hono's first-match doesn't capture it as an id.

// YYYY-MM-DD shape guard for the from/to expense-date filters. A malformed
// value returns a clean 400 rather than letting Postgres throw "invalid input
// syntax for type date" → 500.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Receipt capture (slice 8.9g). All tiers; image always saved. 10 MB cap +
// the three formats a phone camera / scanner produces. The mime → extension
// map doubles as the upload allowlist.
const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;
const RECEIPT_MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'application/pdf': 'pdf',
};

// Stateless AI callers — the model is resolved per call from the account's
// credential, so these hold no key and are safe to build once. deps.extractor /
// deps.categorizer override them (tests inject stubs); otherwise the real caller
// is used and availability is decided by the credential resolver.
const defaultExtractor = createReceiptExtractor();
const defaultCategorizer = createExpenseCategorizer();

export function expensesRoutes(deps: AppDeps) {
  return (
    new Hono<{ Variables: RlsVariables }>()
      .post(
        '/api/expenses',
        requireCapability('expenses:write'),
        requireEntitlement(deps, 'documents:write'),
        async (c) => {
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
          // Money-account kind, not account_type (TMC-207). A credit card is a
          // LIABILITY that money legitimately moves through — "I filled the
          // truck on the fuel card" — so an asset test would refuse the single
          // most common case this feature exists for. The old test also let
          // through Accounts Receivable and Accumulated Depreciation, which are
          // assets nobody pays for fuel with.
          //
          // isActive is checked because this is NEW work: an archived account
          // still resolves for reversals of expenses that already used it, but
          // must not be offered for a fresh one.
          if (!payment || !payment.moneyAccountKind || !payment.isActive) {
            return c.json({ error: 'invalid_payment_account' }, 400);
          }

          // First-expense onboarding milestone (server-authoritative). Checked
          // BEFORE the insert so "the account's first expense" is honest.
          const [priorExpense] = await tx
            .select({ id: expenses.id })
            .from(expenses)
            .where(eq(expenses.accountId, accountId))
            .limit(1);

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
          if (!priorExpense) {
            await emit(tx, { name: 'onboarding_step_completed', step: 'first_expense' });
          }

          return c.json(created, 201);
        },
      )
      // ---- Text expense categorization (AI) -----------------------------
      // Stateless suggestion for the new/edit expense form: given the typed
      // merchant (+ optional memo/amount) the fast model picks a category from
      // the company's expense COA. The user reviews + saves — the AI never
      // writes the ledger. Opt-in like /extract: 503 when no LLM is configured.
      // A literal path, so it never collides with the /api/expenses/:id routes.
      .post(
        '/api/expenses/categorize',
        requireCapability('expenses:write'),
        requireEntitlement(deps, 'ai'),
        rateLimit(deps, RATE_LIMITS.ai, (c) => c.get('accountId') as string | undefined),
        async (c) => {
          const body = await c.req.json().catch(() => null);
          const parsed = expenseCategorizeSchema.safeParse(body);
          if (!parsed.success) {
            return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
          }

          const accountId = c.get('accountId');
          const credential = await resolveAccountCredential(deps, accountId);
          if (!credential) return c.json({ error: 'ai_not_configured' }, 503);
          const categorizer = deps.categorizer ?? defaultCategorizer;
          const { companyId, merchant, memo, amount } = parsed.data;

          // tx1: validate the company + load the COA the model must choose from,
          // then release the connection — this is a deferred-tx route (see
          // rls-context) so the model call below never pins a pooled connection.
          const loaded = await c.var.runInTx(async (tx) => {
            const [company] = await tx
              .select({ id: companies.id, businessType: companies.businessType })
              .from(companies)
              .where(and(eq(companies.id, companyId), eq(companies.accountId, accountId)))
              .limit(1);
            if (!company) return null;
            // The company's active expense COA — the model's suggestion is
            // constrained to these codes (in the prompt and by post-hoc validation
            // inside the categorizer) so it can't return a code that wouldn't post.
            const rows = await tx
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
            // Awaited rather than returning the query builder: runInTx awaits the
            // thenable, which worked when the COA rows were the only thing this
            // closure produced, but can't carry a second value.
            return { businessType: company.businessType, categories: rows };
          });
          if (!loaded) return c.json({ error: 'company_not_found' }, 404);
          const { businessType, categories } = loaded;

          // Model call — no DB connection held.
          let suggestedCategoryCode: string | null;
          try {
            ({ suggestedCategoryCode } = await categorizer.categorize(
              {
                merchant,
                memo: memo ?? null,
                amount: amount ?? null,
                allowedCategories: categories.map((row) => ({ code: row.code, name: row.name })),
                businessType,
              },
              credential,
            ));
          } catch (err) {
            await recordLlmCallHealth(deps.llmConnections, accountId, credential, err);
            return c.json({ error: 'categorization_failed' }, 502);
          }
          // Success (the catch returns) → clear any prior error, state-change-only.
          await recordLlmCallHealth(deps.llmConnections, accountId, credential);

          // Resolve code → account id for the form prefill (the select is keyed by
          // id; codes are the stable persisted form). Null when nothing fit.
          const suggestedCategoryAccountId = suggestedCategoryCode
            ? (categories.find((row) => row.code === suggestedCategoryCode)?.id ?? null)
            : null;

          // Telemetry (opt-in; no-op unless the account enabled it). Same event
          // the receipt path emits — the AI did the categorisation work; the user
          // still confirms on save (TELEMETRY.md). tx2: a short write, opened only
          // when there's something to record.
          if (suggestedCategoryCode) {
            await c.var.runInTx(async (tx) => {
              await emit(tx, { name: 'expense_categorised', method: 'ai_suggested' });
            });
          }

          return c.json({ suggestedCategoryCode, suggestedCategoryAccountId });
        },
      )
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

        const conditions = [eq(expenses.accountId, accountId)];
        // Deleted rows are hidden unless asked for — the same shape as the items
        // catalog's includeArchived, and for the same reason: the list is the
        // only place a user can find a deleted row again and restore it, so it
        // has to be able to show them.
        if (c.req.query('includeDeleted') !== 'true') {
          conditions.push(isNull(expenses.deletedAt));
        }
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
        // Allocations ride along on the detail read so the edit form can render
        // the current answer to "what was this for?" without a second call.
        const allocations = await tx
          .select({
            invoiceId: expenseAllocations.invoiceId,
            jobId: expenseAllocations.jobId,
            share: expenseAllocations.share,
          })
          .from(expenseAllocations)
          .where(
            and(eq(expenseAllocations.expenseId, id), eq(expenseAllocations.accountId, accountId)),
          );
        return c.json({ ...expense, allocations });
      })
      // Job costing (TMC-174) — "what was this for?". Replace-all rather than
      // incremental: the set has to sum to 1, which is only checkable with the
      // whole set in hand, and it makes re-answering the question idempotent.
      //
      // An empty list clears the answer back to never-answered. A single row
      // with invoiceId null is the SHARED answer — deliberate, and distinct
      // from never-answered, which is why both states exist.
      //
      // No ledger posting and no audit row: this is a tag, not a route. It
      // changes nothing about what the expense IS, only what it is attributed
      // to, and the books are identical either way.
      //
      // No search reindex either, and for the same reason — the expense
      // document carries merchant, memo and amount, none of which this touches.
      // The trip-wire: if the expense projector ever indexes the allocated
      // job's name (so "receipts for the Smith job" works), this endpoint
      // becomes a reindex trigger and must call reindexEntities. See the note
      // on projectJobs.
      .put(
        '/api/expenses/:id/allocations',
        requireCapability('expenses:write'),
        validator('json', (value, c) => {
          const parsed = expenseAllocationsSchema.safeParse(value);
          if (!parsed.success) {
            return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
          }
          return parsed.data;
        }),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
          const { allocations } = c.req.valid('json');
          const tx = c.get('tx');
          const accountId = c.get('accountId');

          const [expense] = await tx
            .select({
              id: expenses.id,
              companyId: expenses.companyId,
              deletedAt: expenses.deletedAt,
            })
            .from(expenses)
            .where(and(eq(expenses.id, id), eq(expenses.accountId, accountId)))
            .limit(1);
          if (!expense || expense.deletedAt) return c.json({ error: 'expense_not_found' }, 404);

          // Every named invoice must exist inside the same account AND the same
          // company as the expense. RLS pins the account only, so the company
          // check is ours to make — without it a cost could be attributed to a
          // job belonging to a sibling company in the same account.
          const invoiceIds = allocations
            .map((a) => a.invoiceId)
            .filter((v): v is string => v !== null);
          if (invoiceIds.length > 0) {
            const found = await tx
              .select({ id: invoices.id, companyId: invoices.companyId })
              .from(invoices)
              .where(and(inArray(invoices.id, invoiceIds), eq(invoices.accountId, accountId)));
            if (found.length !== invoiceIds.length) {
              return c.json({ error: 'invoice_not_found' }, 404);
            }
            if (found.some((row) => row.companyId !== expense.companyId)) {
              return c.json({ error: 'invoice_company_mismatch' }, 400);
            }
          }

          // Same check at job grain (TMC-181). A row names an invoice or a job,
          // never both — the schema and a DB CHECK both enforce that — so these
          // two guards are independent rather than exclusive.
          const jobIds = allocations.map((a) => a.jobId).filter((v): v is string => v !== null);
          if (jobIds.length > 0) {
            const found = await tx
              .select({ id: jobs.id, companyId: jobs.companyId })
              .from(jobs)
              .where(and(inArray(jobs.id, jobIds), eq(jobs.accountId, accountId)));
            if (found.length !== new Set(jobIds).size) {
              return c.json({ error: 'job_not_found' }, 404);
            }
            if (found.some((row) => row.companyId !== expense.companyId)) {
              return c.json({ error: 'job_company_mismatch' }, 400);
            }
          }

          await tx
            .delete(expenseAllocations)
            .where(
              and(
                eq(expenseAllocations.expenseId, id),
                eq(expenseAllocations.accountId, accountId),
              ),
            );
          if (allocations.length > 0) {
            await tx.insert(expenseAllocations).values(
              allocations.map((a) => ({
                id: uuidv7(),
                accountId,
                companyId: expense.companyId,
                expenseId: id,
                invoiceId: a.invoiceId,
                jobId: a.jobId,
                share: a.share,
              })),
            );
          }

          return c.json({ allocations });
        },
      )
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
          if (!newPayment || !newPayment.moneyAccountKind || !newPayment.isActive) {
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
        // The UPDATE is the guard, not the SELECT above it. Two deletes racing
        // (a double-click on a slow connection) both read a live row, and
        // without isNull the second one re-stamps an already-deleted row and
        // posts the reversal a SECOND time — leaving the expense counted at
        // minus one on the books. Re-checked under the row lock, the loser
        // matches nothing and returns without posting.
        const [deleted] = await tx
          .update(expenses)
          .set({ deletedAt: now, updatedAt: now })
          .where(
            and(eq(expenses.id, id), eq(expenses.accountId, accountId), isNull(expenses.deletedAt)),
          )
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
      // The other half of the soft delete (TMC-240). Without this the row's
      // survival bought the user nothing: deleted_at was a one-way door with a
      // database row behind it.
      //
      // Restore is the delete run backwards — clear the stamp, post the original
      // lines again — so the GL lands exactly where it was before the delete.
      // Append-only means three entries (create, reversal, re-create) net to one
      // expense, which is the honest record of what happened.
      .post('/api/expenses/:id/restore', requireCapability('expenses:write'), async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        const tx = c.get('tx');
        const accountId = c.get('accountId');

        const [current] = await tx
          .select()
          .from(expenses)
          .where(and(eq(expenses.id, id), eq(expenses.accountId, accountId)))
          .limit(1);
        if (!current) return c.json({ error: 'expense_not_found' }, 404);
        // Restoring a live row is a no-op, not a second posting. The idempotence
        // matters more here than it does for the items archive pair: a double
        // POST there flips a flag twice, here it would double the expense.
        if (!current.deletedAt) return c.json(current);

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
        // Same compare-and-swap as the delete above, mirrored: only the
        // transaction that actually clears the stamp is allowed to repost, so a
        // double-submitted restore cannot count the expense twice.
        const [restored] = await tx
          .update(expenses)
          .set({ deletedAt: null, updatedAt: now })
          .where(
            and(
              eq(expenses.id, id),
              eq(expenses.accountId, accountId),
              isNotNull(expenses.deletedAt),
            ),
          )
          .returning();
        if (!restored) return c.json(current);

        await c.var.audit({
          entityType: 'expense',
          entityId: id,
          action: 'restore',
          before: current,
          after: restored,
          companyId: current.companyId,
        });

        // Dated to the expense, not to today, so a restore puts the deduction
        // back on the tax year it belonged to. That also means the period lock
        // refuses a restore into a closed year (409) — correct: reopening the
        // period is the deliberate act that should precede it.
        await postExpenseCreate(tx, {
          expense: { id, merchant: restored.merchant, amount: restored.amount },
          categoryCode: category.code,
          paymentCode: payment.code,
          accountId,
          companyId: current.companyId,
          postedAt: expenseDateToPostedAt(restored.expenseDate),
        });

        return c.json(restored);
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
            // Only to name the downloaded file; neither is used for access.
            merchant: expenses.merchant,
            expenseDate: expenses.expenseDate,
          })
          .from(expenses)
          .where(and(eq(expenses.id, id), eq(expenses.accountId, accountId)))
          .limit(1);
        if (!expense || expense.deletedAt) return c.json({ error: 'expense_not_found' }, 404);
        if (!expense.receiptStorageKey) return c.json({ error: 'no_receipt' }, 404);

        // Two URLs over the same object, because the page needs both at once:
        // `url` renders inline in an <img>, `downloadUrl` saves to disk from the
        // button beside it (TMC-267). Minting both here rather than behind a
        // ?download flag keeps it to one round trip, and signing is cheap.
        const [url, downloadUrl] = await Promise.all([
          deps.storage.getSignedDownloadUrl(expense.receiptStorageKey, { expiresInSeconds: 3600 }),
          deps.storage.getSignedDownloadUrl(expense.receiptStorageKey, {
            expiresInSeconds: 3600,
            downloadFilename: receiptFilename(
              expense.merchant,
              expense.expenseDate,
              expense.receiptStorageKey,
            ),
          }),
        ]);
        return c.json({ url, downloadUrl, contentType: mimeForKey(expense.receiptStorageKey) });
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
      .post(
        '/api/expenses/:id/extract',
        requireCapability('expenses:write'),
        requireEntitlement(deps, 'ai'),
        rateLimit(deps, RATE_LIMITS.ai, (c) => c.get('accountId') as string | undefined),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);

          const accountId = c.get('accountId');
          // Resolve this account's LLM credential (managed or its own BYOK key).
          // Null → no usable key for the account → 503, same as an unconfigured
          // global key used to give. The entitlement 'ai' gate above already
          // answered "may the plan use AI"; this answers "with which key".
          const credential = await resolveAccountCredential(deps, accountId);
          if (!credential) return c.json({ error: 'ai_not_configured' }, 503);
          if (!deps.storage) return c.json({ error: 'storage_not_configured' }, 503);
          const extractor = deps.extractor ?? defaultExtractor;

          // tx1: load the expense + its company's expense COA, then drop the
          // connection before the storage fetch + vision call (both upstream —
          // this is a deferred-tx route, see rls-context).
          const loaded = await c.var.runInTx(async (tx) => {
            const [expense] = await tx
              .select()
              .from(expenses)
              .where(and(eq(expenses.id, id), eq(expenses.accountId, accountId)))
              .limit(1);
            if (!expense || expense.deletedAt) return null;
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
            // Business type for the prompt persona. A separate small select
            // rather than joining companies into the expense query above: that
            // one is select-all, and a join would reshape its rows to
            // { expenses, companies } and break every expense.* reference below.
            // No 404 branch on a miss — expenses.company_id is an FK and both
            // tables are RLS-scoped to the same account, so it cannot be absent.
            const [company] = await tx
              .select({ businessType: companies.businessType })
              .from(companies)
              .where(and(eq(companies.id, expense.companyId), eq(companies.accountId, accountId)))
              .limit(1);
            return { expense, categories, businessType: company?.businessType ?? null };
          });
          if (!loaded) return c.json({ error: 'expense_not_found' }, 404);
          const { expense, categories, businessType } = loaded;
          // Extraction operates on the already-uploaded receipt (capture is 8.9g).
          if (!expense.receiptStorageKey) return c.json({ error: 'no_receipt' }, 400);

          // Storage fetch + vision call — no DB connection held.
          const bytes = await deps.storage.getObject(expense.receiptStorageKey);
          const mimeType = mimeForKey(expense.receiptStorageKey);

          const now = new Date();
          let result: ExtractionResult | null = null;
          let status: 'succeeded' | 'failed';
          let callError: unknown;
          try {
            result = await extractor.extractReceipt(
              {
                bytes,
                mimeType,
                allowedCategories: categories.map((row) => ({ code: row.code, name: row.name })),
                businessType,
              },
              credential,
            );
            status = 'succeeded';
          } catch (err) {
            status = 'failed';
            callError = err;
          }
          // Live-call health, state-change-only. A permanent failure (bad key /
          // model) reddens the chip; a transient one (provider 5xx, timeout) is
          // ignored so a blip doesn't demote a working connection.
          await recordLlmCallHealth(
            deps.llmConnections,
            accountId,
            credential,
            status === 'succeeded' ? undefined : callError,
          );

          // tx2: persist the outcome + audit + telemetry. extraction_status is
          // committed even on failure (the throw is swallowed above) so the UI can
          // show the failed state and let the user retry.
          const persisted = await c.var.runInTx(async (tx, audit) => {
            const [updated] = await tx
              .update(expenses)
              .set({ extractionStatus: status, extractionPayload: result, updatedAt: now })
              .where(and(eq(expenses.id, id), eq(expenses.accountId, accountId)))
              .returning();
            if (!updated) return false;

            await audit({
              entityType: 'expense',
              entityId: id,
              action: 'receipt-extract',
              before: { extractionStatus: expense.extractionStatus },
              after: { extractionStatus: status, extraction: result },
              companyId: expense.companyId,
            });

            // The AI did the categorisation work when it returned a usable code;
            // the user still confirms on save. expense_categorised{ai_suggested}
            // is the documented event for this (TELEMETRY.md).
            if (status === 'succeeded' && result?.suggestedCategoryCode) {
              await emit(tx, { name: 'expense_categorised', method: 'ai_suggested' });
            }
            return true;
          });
          if (!persisted) return c.json({ error: 'expense_not_found' }, 404);

          if (status === 'failed' || !result) {
            return c.json({ error: 'extraction_failed', extractionStatus: 'failed' as const }, 502);
          }

          // Resolve the suggested code → account id for the web prefill. Codes are
          // the stable, persisted form; the edit form's category select is keyed
          // by id. Null when the model suggested nothing or a now-removed code.
          const suggestedCategoryAccountId = result.suggestedCategoryCode
            ? (categories.find((row) => row.code === result?.suggestedCategoryCode)?.id ?? null)
            : null;

          return c.json({
            extractionStatus: 'succeeded' as const,
            extraction: result,
            suggestedCategoryAccountId,
          });
        },
      )
  );
}

export type ExpensesAppType = ReturnType<typeof expensesRoutes>;

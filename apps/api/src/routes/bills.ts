import { billPayments, bills, chartOfAccounts, companies, contacts } from '@thalermark/db';
import {
  billCreateSchema,
  billMarkPaidSchema,
  billPaymentCreateSchema,
  billUpdateSchema,
  centsToMoney,
  toCents,
} from '@thalermark/validation';
import { and, asc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { v7 as uuidv7 } from 'uuid';
import {
  checkBillPaymentEligibility,
  paidCentsForBill,
  paymentCountForBill,
  summarizeBillSettlement,
  syncBillSettlement,
} from '../lib/bill-payments.js';
import {
  postBillOpen,
  postBillOpenReversal,
  postBillPayment,
  postBillPaymentReceipt,
  postBillPaymentReceiptReversal,
} from '../lib/ledger.js';
import { applyCursor, keysetOrderBy, parseLimit, slicePage } from '../lib/pagination.js';
import {
  UUID_RE,
  expenseDateToPostedAt,
  resolveCoaAccounts,
  resolveVendorLink,
} from '../lib/route-helpers.js';
import { requireCapability } from '../middleware/authz.js';
import type { RlsVariables } from '../middleware/rls-context.js';

// bills — the Accounts Payable / vendor-bills domain: a bill is the accrual
// sibling of an expense (header-only: single vendor + category + amount).
// Create posts Dr <category> / Cr AP (2000); mark-paid posts Dr AP / Cr
// <payment asset>; void reverses the open posting; edit (open-only) reverses +
// reposts. Plus AP aging. Deps-free — the parent cors + rls-context middleware
// runs for these paths (registered before the .route() mount in createApp). The
// first domain carved out (the modular-sub-apps proof, #314); this folds it
// from an app.ts-local function into a routes/ sub-app like the rest, so it
// rides the unified client facade instead of a second hc<BillsAppType> client.

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

// Resolves the account a bill payment leaves from. Shared by mark-paid and the
// per-payment route.
//
// That set is exactly Cash (1000) today, and an explicit pick is checked
// AGAINST it rather than merely being validated as an asset. The old check —
// any account_type 'asset' — was harmless while nothing surfaced a choice and
// every caller took the default, but the chart seeds Accounts Receivable,
// Vehicles & Equipment and Accumulated Depreciation as assets too, and "paid
// this bill out of Accumulated Depreciation" posts a balanced entry that is
// nonsense. A balanced wrong answer is the failure this codebase is built to
// avoid, so the set is named rather than inferred from the type.
//
// The chart is seed-only — there is no endpoint that creates a
// chart_of_accounts row — so there is currently no second cash or bank account
// for a user to pick even in principle. When one lands, this becomes a set
// membership and the clients get a real picker back; the same single-Cash pin
// is already documented in ledger.ts's cash reads.
const PAYABLE_FROM_CODES = ['1000'];

async function resolvePaymentAccount(
  tx: RlsVariables['tx'],
  args: { accountId: string; companyId: string; paymentAccountId?: string | undefined },
): Promise<{ id: string; code: string } | { error: 'invalid_payment_account' }> {
  const [cash] = await tx
    .select({ id: chartOfAccounts.id, code: chartOfAccounts.code })
    .from(chartOfAccounts)
    .where(
      and(
        eq(chartOfAccounts.accountId, args.accountId),
        eq(chartOfAccounts.companyId, args.companyId),
        inArray(chartOfAccounts.code, PAYABLE_FROM_CODES),
      ),
    )
    .limit(1);
  if (!cash) throw new Error(`company ${args.companyId}: Cash account missing`);
  if (args.paymentAccountId && args.paymentAccountId !== cash.id) {
    return { error: 'invalid_payment_account' };
  }
  return cash;
}

// The vendor name behind a bill, for the GL memo. Falls back rather than
// throwing: a posting is not worth failing over a display string.
async function vendorNameForBill(
  tx: RlsVariables['tx'],
  args: { accountId: string; contactId: string },
): Promise<string> {
  const [vendor] = await tx
    .select({ name: contacts.name })
    .from(contacts)
    .where(and(eq(contacts.id, args.contactId), eq(contacts.accountId, args.accountId)))
    .limit(1);
  return vendor?.name ?? 'vendor';
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

export function billsRoutes() {
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

        // What is still OWED on each of them, not what was billed (TMC-192). An
        // open bill can now carry a deposit, and aging that reports the full
        // amount overstates payables by every deposit already paid — the number
        // this report exists to get right. One grouped read over the page's
        // bills rather than a per-bill query.
        const paidByBill = new Map<string, number>();
        if (rows.length > 0) {
          const sums = await tx
            .select({
              billId: billPayments.billId,
              paid: sql<string>`coalesce(sum(${billPayments.amount}), 0)::numeric(15,2)`,
            })
            .from(billPayments)
            .where(
              and(
                eq(billPayments.accountId, accountId),
                inArray(
                  billPayments.billId,
                  rows.map((r) => r.id),
                ),
              ),
            )
            .groupBy(billPayments.billId);
          for (const s of sums) paidByBill.set(s.billId, toCents(s.paid));
        }

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
          // `amount` is reported as the outstanding balance, not the original
          // total. The field keeps its name because the clients, the CSV export
          // and the mobile aging screen all read it, and what an aging report
          // means by "amount" has always been "what you still owe".
          const cents = Math.round(Number(r.amount) * 100) - (paidByBill.get(r.id) ?? 0);
          bucketCents[bucket] += cents;
          totalCents += cents;
          return { ...r, amount: centsToMoney(cents), daysOverdue, bucket };
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

          // An edit can change the amount out from under existing payments
          // (TMC-192) — the vendor sends a corrected bill after a deposit has
          // gone out. The ledger is already right: reverse + repost leaves AP at
          // (new amount − paid). What is NOT automatically right is the status
          // column, because a bill corrected DOWN to the deposit is now settled.
          //
          // Only when the amount actually moved. Settlement is amount vs paid
          // and nothing else, so a memo or due-date edit cannot change it — and
          // this is the common edit. Keeping the extra reads off that path is
          // the same concern TMC-205 raises about riding work inside a write.
          if (next.amount !== current.amount) {
            const synced = await syncBillSettlement(tx, {
              accountId,
              billId: id,
              amountCents: toCents(next.amount),
            });
            if (synced) return c.json(synced.bill);
          }

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

          // mark-paid settles the FULL amount in one shot. A bill carrying
          // payment rows is already partly settled, so this path would post the
          // whole amount a second time and strand the header against rows that
          // say something else — the invoice-side bug TMC-199 fixed on mobile.
          // Rows, not the net: a bill paid and then fully refunded nets to zero
          // and still must not take the single-shot path, because nothing here
          // re-derives status from the rows afterwards.
          const existingPaymentCount = await paymentCountForBill(tx, { accountId, billId: id });
          if (existingPaymentCount > 0) {
            return c.json({ error: 'has_payments', existingPaymentCount }, 409);
          }

          const payment = await resolvePaymentAccount(tx, {
            accountId,
            companyId: current.companyId,
            paymentAccountId,
          });
          if ('error' in payment) return c.json({ error: payment.error }, 400);

          // Payment date drives both paidAt and the settlement posting date.
          const paidAt = paidOn ? new Date(`${paidOn}T00:00:00.000Z`) : new Date();

          const [updated] = await tx
            .update(bills)
            .set({
              status: 'paid',
              paymentAccountId: payment.id,
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

          const vendorName = await vendorNameForBill(tx, {
            accountId,
            contactId: current.contactId,
          });
          await postBillPayment(tx, {
            bill: {
              id,
              amount: current.amount,
              label: billMemoLabel(vendorName, current.reference),
            },
            paymentCode: payment.code,
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

        // ...and 'open' is no longer proof that no money has moved (TMC-192).
        // The void posting credits the category and debits AP for the FULL
        // amount, which was only ever correct while an open bill could not have
        // payments against it. A part-paid bill is still 'open', so voiding it
        // would clear a liability that the payments had already partly cleared
        // and drive AP the wrong way. Same guard, same reasoning, as the
        // invoice void (TMC-188).
        //
        // On the NET, not the row count, so the legitimate "we paid, they
        // refunded us in full, now cancel the bill" flow still voids cleanly:
        // those two rows net to zero and AP is back at the full amount, which
        // is exactly what the void reverses.
        const paidCents = await paidCentsForBill(tx, { accountId, billId: id });
        if (paidCents !== 0) return c.json({ error: 'has_payments', paidCents }, 409);

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

        const vendorName = await vendorNameForBill(tx, {
          accountId,
          contactId: current.contactId,
        });
        // Reverse the open posting at its original date so the period nets to
        // zero (the AP balance is reversal-safe regardless, but period reports
        // should tie out).
        await postBillOpenReversal(tx, {
          bill: {
            id,
            amount: current.amount,
            label: billMemoLabel(vendorName, current.reference),
          },
          categoryCode: category.code,
          accountId,
          companyId: current.companyId,
          postedAt: billDateToPostedAt(current.billDate),
        });

        return c.json(updated);
      })
      // --- Payments (TMC-192) ------------------------------------------------
      // Money paid against a bill. This is the vendor-deposit path: a supplier
      // wants half up front on a materials order, it goes out, and the bill
      // reads half-paid instead of having to be lied about in one direction or
      // the other.
      //
      // mark-paid above is now the special case of this — a payment for the
      // whole amount — rather than the only way money can leave. It is left
      // exactly as it was (plus a guard refusing a bill that already has rows)
      // so the quick path and every existing caller are untouched.
      // Unguarded like every other read in this file: the capability model gates
      // writes, and any member who can see a bill can see what has been paid.
      .get('/api/bills/:id/payments', async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        const tx = c.get('tx');
        const accountId = c.get('accountId');

        const [bill] = await tx
          .select({ id: bills.id, amount: bills.amount })
          .from(bills)
          .where(and(eq(bills.id, id), eq(bills.accountId, accountId)))
          .limit(1);
        if (!bill) return c.json({ error: 'bill_not_found' }, 404);

        const payments = await tx
          .select()
          .from(billPayments)
          .where(and(eq(billPayments.accountId, accountId), eq(billPayments.billId, id)))
          .orderBy(asc(billPayments.paidOn), asc(billPayments.id));

        const paidCents = payments.reduce((sum, p) => sum + toCents(p.amount), 0);
        return c.json({
          payments,
          ...summarizeBillSettlement({ amountCents: toCents(bill.amount), paidCents }),
        });
      })
      .post(
        '/api/bills/:id/payments',
        requireCapability('expenses:write'),
        validator('json', (value, c) => {
          const parsed = billPaymentCreateSchema.safeParse(value);
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

          const existingPaymentCount = await paymentCountForBill(tx, { accountId, billId: id });
          const eligible = checkBillPaymentEligibility({
            status: current.status,
            existingPaymentCount,
          });
          if (!eligible.ok) {
            return c.json({ error: eligible.reason, status: current.status }, 409);
          }

          // Resolved and STORED per payment, not read back off the bill header.
          // Half from the business account and half in cash is the case this
          // table exists for, and a reversal has to reproduce the same lines it
          // is cancelling — an account that moved between postings would leave a
          // residue behind in the origin period.
          const account = await resolvePaymentAccount(tx, {
            accountId,
            companyId: current.companyId,
            paymentAccountId: data.paymentAccountId,
          });
          if ('error' in account) return c.json({ error: account.error }, 400);

          const paymentId = uuidv7();
          const [payment] = await tx
            .insert(billPayments)
            .values({
              id: paymentId,
              accountId,
              companyId: current.companyId,
              billId: id,
              paymentAccountId: account.id,
              amount: data.amount,
              paidOn: data.paidOn,
              method: data.method,
              reference: data.reference ?? null,
            })
            .returning();
          if (!payment) return c.json({ error: 'bill_not_found' }, 404);

          const vendorName = await vendorNameForBill(tx, {
            accountId,
            contactId: current.contactId,
          });
          // Posts inside the tenant tx like every other mutation, so the
          // deferred sum-to-zero trigger fires at commit and a rejected posting
          // (closed period, retired company) rolls the row back with it.
          await postBillPaymentReceipt(tx, {
            payment: { amount: payment.amount, paymentCode: account.code },
            bill: { id, label: billMemoLabel(vendorName, current.reference) },
            accountId,
            companyId: current.companyId,
            postedAt: billDateToPostedAt(payment.paidOn),
          });

          const synced = await syncBillSettlement(tx, {
            accountId,
            billId: id,
            amountCents: toCents(current.amount),
          });
          if (!synced) return c.json({ error: 'bill_not_found' }, 404);

          await c.var.audit({
            entityType: 'bill',
            entityId: id,
            action: 'payment-recorded',
            before: { status: current.status },
            after: {
              status: synced.bill.status,
              settlement: synced.summary.settlement,
              paymentId,
              amount: payment.amount,
              paidOn: payment.paidOn,
              method: payment.method,
            },
            companyId: current.companyId,
          });

          return c.json({ payment, bill: synced.bill, ...synced.summary }, 201);
        },
      )
      // Removing a payment is an append-only ledger correction, not a deletion
      // of history: the reversal posts at the date the payment was ORIGINALLY
      // booked, so the period it belonged to nets to zero rather than the cash
      // jumping into the current month.
      .delete(
        '/api/bills/:id/payments/:paymentId',
        requireCapability('expenses:write'),
        async (c) => {
          const id = c.req.param('id');
          const paymentId = c.req.param('paymentId');
          if (!UUID_RE.test(id) || !UUID_RE.test(paymentId)) {
            return c.json({ error: 'invalid_id' }, 400);
          }
          const tx = c.get('tx');
          const accountId = c.get('accountId');

          const [current] = await tx
            .select()
            .from(bills)
            .where(and(eq(bills.id, id), eq(bills.accountId, accountId)))
            .limit(1);
          if (!current) return c.json({ error: 'bill_not_found' }, 404);

          const [payment] = await tx
            .select()
            .from(billPayments)
            .where(
              and(
                eq(billPayments.id, paymentId),
                eq(billPayments.accountId, accountId),
                eq(billPayments.billId, id),
              ),
            )
            .limit(1);
          if (!payment) return c.json({ error: 'payment_not_found' }, 404);

          // The payment's OWN account, not the bill header's. They differ the
          // moment a second payment leaves a different account, and reversing
          // against the wrong one would move money between two real assets that
          // never traded.
          const coa = await resolveCoaAccounts(
            tx,
            accountId,
            current.companyId,
            payment.paymentAccountId ? [payment.paymentAccountId] : [],
          );
          const paymentCode = payment.paymentAccountId
            ? coa.get(payment.paymentAccountId)?.code
            : undefined;
          if (!paymentCode) {
            throw new Error(`bill payment ${paymentId}: stored payment account missing`);
          }

          const vendorName = await vendorNameForBill(tx, {
            accountId,
            contactId: current.contactId,
          });
          await postBillPaymentReceiptReversal(tx, {
            payment: { amount: payment.amount, paymentCode },
            bill: { id, label: billMemoLabel(vendorName, current.reference) },
            accountId,
            companyId: current.companyId,
            postedAt: billDateToPostedAt(payment.paidOn),
          });

          await tx
            .delete(billPayments)
            .where(and(eq(billPayments.id, paymentId), eq(billPayments.accountId, accountId)));

          const synced = await syncBillSettlement(tx, {
            accountId,
            billId: id,
            amountCents: toCents(current.amount),
          });
          if (!synced) return c.json({ error: 'bill_not_found' }, 404);

          await c.var.audit({
            entityType: 'bill',
            entityId: id,
            action: 'payment-removed',
            before: {
              status: current.status,
              paymentId,
              amount: payment.amount,
              paidOn: payment.paidOn,
              method: payment.method,
            },
            after: { status: synced.bill.status, settlement: synced.summary.settlement },
            companyId: current.companyId,
          });

          return c.json({ bill: synced.bill, ...synced.summary });
        },
      )
  );
}

export type BillsAppType = ReturnType<typeof billsRoutes>;

import { bills, chartOfAccounts, companies, contacts } from '@thalermark/db';
import { billCreateSchema, billMarkPaidSchema, billUpdateSchema } from '@thalermark/validation';
import { and, asc, eq, getTableColumns, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { v7 as uuidv7 } from 'uuid';
import { postBillOpen, postBillOpenReversal, postBillPayment } from '../lib/ledger.js';
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

export type BillsAppType = ReturnType<typeof billsRoutes>;

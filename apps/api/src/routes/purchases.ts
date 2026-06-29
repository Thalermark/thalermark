import {
  capitalPurchases,
  chartOfAccounts,
  companies,
  contacts,
  journalEntries,
  journalLines,
} from '@thalermark/db';
import { capitalPurchaseCreateSchema, loanPaymentSchema } from '@thalermark/validation';
import { and, eq, getTableColumns, inArray, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { v7 as uuidv7 } from 'uuid';
import {
  type CapitalPurchaseTaxTreatment,
  depreciationSchedule,
  loanBalance,
  postCapitalPurchase,
  postCapitalPurchaseReversal,
  postLoanPayment,
} from '../lib/ledger.js';
import { applyCursor, keysetOrderBy, parseLimit, slicePage } from '../lib/pagination.js';
import { UUID_RE, expenseDateToPostedAt, resolveVendorLink } from '../lib/route-helpers.js';
import { requireCapability } from '../middleware/authz.js';
import type { RlsVariables } from '../middleware/rls-context.js';

// purchases — "big purchases" in plain language: durable gear bought and used
// for years ("a mower on payments"). The honest accounting the MVP couldn't do,
// all hidden behind life-questions (what did you buy / how much / paid now or
// over time / how to handle on taxes). Reached from a branch in the Expenses
// flow, not its own nav.
//
// On create the row write + audit + posting run in one tenant tx so the deferred
// sum-to-zero trigger fires at commit. A purchase capitalizes the cost (Dr 1500),
// funds it from cash and/or a loan (Cr 1000 / Cr 2700), and — when "deduct it all
// this year" — posts the full §179 write-off (Dr 6350 / Cr 1900). The financed
// balance is DERIVED from the ledger per purchase (loanBalance), so a "record a
// payment" just posts Dr 2700 / Dr 6500 / Cr 1000 against the same source group.
// Gated by expenses:write — the money-out cluster. entityType 'capital_purchase'
// is registered in the activity feed (routes/audit-events.ts). Deps-free
// pure-tenant sub-app (cf. owner-money / bills); mounted via .route() on its own
// PurchasesAppType.

// Cash paid up front: the whole price when paid in full, else the down payment.
function paidNowFor(funding: string, amount: string, downPayment: string | null): string {
  if (funding === 'paid_in_full') return amount;
  return downPayment ?? '0';
}

export function purchasesRoutes() {
  return new Hono<{ Variables: RlsVariables }>()
    .post('/api/purchases', requireCapability('expenses:write'), async (c) => {
      const body = await c.req.json().catch(() => null);
      const parsed = capitalPurchaseCreateSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
      }

      const tx = c.get('tx');
      const accountId = c.get('accountId');
      const { companyId, vendorContactId, ...rest } = parsed.data;

      const [company] = await tx
        .select({ id: companies.id })
        .from(companies)
        .where(and(eq(companies.id, companyId), eq(companies.accountId, accountId)))
        .limit(1);
      if (!company) return c.json({ error: 'company_not_found' }, 404);

      // Vendor (who you bought from) is optional. resolveVendorLink validates
      // same account+company and marks is_vendor when present.
      const vendor = await resolveVendorLink(tx, accountId, companyId, vendorContactId);
      if (vendor && 'error' in vendor) return c.json({ error: vendor.error }, vendor.status);

      const downPayment = rest.funding === 'paid_in_full' ? rest.amount : (rest.downPayment ?? '0');
      const paidNow = paidNowFor(rest.funding, rest.amount, downPayment);

      const purchaseId = uuidv7();
      const [created] = await tx
        .insert(capitalPurchases)
        .values({
          id: purchaseId,
          accountId,
          companyId,
          description: rest.description,
          amount: rest.amount,
          purchaseDate: rest.purchaseDate,
          funding: rest.funding,
          downPayment,
          taxTreatment: rest.taxTreatment,
          usefulLifeYears: rest.usefulLifeYears ?? 5,
          vendorContactId: vendorContactId ?? null,
          memo: rest.memo ?? null,
        })
        .returning();

      await c.var.audit({
        entityType: 'capital_purchase',
        entityId: purchaseId,
        action: 'create',
        after: created,
        companyId,
      });

      await postCapitalPurchase(tx, {
        purchase: {
          id: purchaseId,
          amount: rest.amount,
          paidNow,
          taxTreatment: rest.taxTreatment,
          description: rest.description,
        },
        accountId,
        companyId,
        postedAt: expenseDateToPostedAt(rest.purchaseDate),
      });

      return c.json(created, 201);
    })
    .get('/api/purchases', async (c) => {
      const tx = c.get('tx');
      const accountId = c.get('accountId');
      const companyId = c.req.query('companyId');

      const limit = parseLimit(c.req.query('limit'));
      if (limit === null) return c.json({ error: 'invalid_limit' }, 400);
      const keys = [
        { col: capitalPurchases.purchaseDate },
        { col: capitalPurchases.createdAt, revive: (v: unknown) => new Date(v as string) },
        { col: capitalPurchases.id },
      ];
      const keyset = applyCursor(c.req.query('cursor'), keys, 'desc');
      if (keyset === 'invalid') return c.json({ error: 'invalid_cursor' }, 400);

      const conditions = [
        eq(capitalPurchases.accountId, accountId),
        isNull(capitalPurchases.deletedAt),
      ];
      if (companyId) conditions.push(eq(capitalPurchases.companyId, companyId));

      const rows = await tx
        .select({ ...getTableColumns(capitalPurchases), vendorName: contacts.name })
        .from(capitalPurchases)
        .leftJoin(contacts, eq(contacts.id, capitalPurchases.vendorContactId))
        .where(and(...conditions, ...(keyset ? [keyset] : [])))
        .orderBy(keysetOrderBy(keys, 'desc'))
        .limit(limit + 1);
      const page = slicePage(rows, limit, (r) => [r.purchaseDate, r.createdAt, r.id]);

      // Per-purchase loan balance in one batched query (not N+1): net credit on
      // Loans Payable (2700) grouped by source_entity_id over the page's ids.
      const pageIds = page.rows.map((r) => r.id);
      const owingById = new Map<string, string>();
      if (pageIds.length > 0) {
        const owingRows = await tx
          .select({
            purchaseId: journalEntries.sourceEntityId,
            owing: sql<string>`coalesce(sum(case when ${journalLines.side} = 'credit' then ${journalLines.amount} else -${journalLines.amount} end), 0)::numeric(15,2)`,
          })
          .from(journalLines)
          .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
          .innerJoin(chartOfAccounts, eq(journalLines.coaAccountId, chartOfAccounts.id))
          .where(
            and(
              eq(journalEntries.accountId, accountId),
              eq(chartOfAccounts.code, '2700'),
              inArray(journalEntries.sourceEntityId, pageIds),
            ),
          )
          .groupBy(journalEntries.sourceEntityId);
        for (const r of owingRows) owingById.set(r.purchaseId, r.owing);
      }

      return c.json({
        purchases: page.rows.map((r) => ({ ...r, owing: owingById.get(r.id) ?? '0.00' })),
        nextCursor: page.nextCursor,
      });
    })
    .get('/api/purchases/:id', async (c) => {
      const id = c.req.param('id');
      if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
      const tx = c.get('tx');
      const accountId = c.get('accountId');

      const [purchase] = await tx
        .select({ ...getTableColumns(capitalPurchases), vendorName: contacts.name })
        .from(capitalPurchases)
        .leftJoin(contacts, eq(contacts.id, capitalPurchases.vendorContactId))
        .where(and(eq(capitalPurchases.id, id), eq(capitalPurchases.accountId, accountId)))
        .limit(1);
      if (!purchase || purchase.deletedAt) {
        return c.json({ error: 'purchase_not_found' }, 404);
      }

      const owing = await loanBalance(tx, {
        accountId,
        companyId: purchase.companyId,
        purchaseId: id,
      });
      // The plain "spread it out" answer (about $X/year for N years). Null for
      // the deduct-now path (already fully written off at purchase).
      const schedule =
        purchase.taxTreatment === 'spread'
          ? depreciationSchedule(purchase.amount, purchase.usefulLifeYears)
          : null;

      return c.json({ ...purchase, owing, schedule });
    })
    .post(
      '/api/purchases/:id/payments',
      requireCapability('expenses:write'),
      validator('json', (value, c) => {
        const parsed = loanPaymentSchema.safeParse(value);
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
        const { amount, interest, paidOn } = c.req.valid('json');

        const [purchase] = await tx
          .select()
          .from(capitalPurchases)
          .where(and(eq(capitalPurchases.id, id), eq(capitalPurchases.accountId, accountId)))
          .limit(1);
        if (!purchase || purchase.deletedAt) {
          return c.json({ error: 'purchase_not_found' }, 404);
        }
        if (purchase.funding !== 'financed') {
          return c.json({ error: 'not_financed' }, 409);
        }

        // Can't pay down more principal than is still owed.
        const owing = await loanBalance(tx, {
          accountId,
          companyId: purchase.companyId,
          purchaseId: id,
        });
        const principalCents =
          Math.round(Number(amount) * 100) - Math.round(Number(interest) * 100);
        if (principalCents > Math.round(Number(owing) * 100)) {
          return c.json({ error: 'payment_exceeds_balance', owing }, 409);
        }

        await postLoanPayment(tx, {
          purchaseId: id,
          description: purchase.description,
          amount,
          interest,
          accountId,
          companyId: purchase.companyId,
          postedAt: expenseDateToPostedAt(paidOn),
        });

        await c.var.audit({
          entityType: 'capital_purchase',
          entityId: id,
          action: 'payment',
          after: { amount, interest, paidOn },
          companyId: purchase.companyId,
        });

        const newOwing = await loanBalance(tx, {
          accountId,
          companyId: purchase.companyId,
          purchaseId: id,
        });
        return c.json({ id, owing: newOwing });
      },
    )
    .delete('/api/purchases/:id', requireCapability('expenses:write'), async (c) => {
      const id = c.req.param('id');
      if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
      const tx = c.get('tx');
      const accountId = c.get('accountId');

      const [current] = await tx
        .select()
        .from(capitalPurchases)
        .where(and(eq(capitalPurchases.id, id), eq(capitalPurchases.accountId, accountId)))
        .limit(1);
      if (!current || current.deletedAt) {
        return c.json({ error: 'purchase_not_found' }, 404);
      }

      // A financed purchase with payments already recorded can't be deleted —
      // unwinding the payments too is out of scope. Block it cleanly. (Paid in
      // full has no payments, so it always deletes.) The loan balance differs
      // from the original financed amount exactly when a payment was made.
      if (current.funding === 'financed') {
        const owing = await loanBalance(tx, {
          accountId,
          companyId: current.companyId,
          purchaseId: id,
        });
        const financed =
          Math.round(Number(current.amount) * 100) - Math.round(Number(current.downPayment) * 100);
        if (Math.round(Number(owing) * 100) !== financed) {
          return c.json({ error: 'has_payments' }, 409);
        }
      }

      const now = new Date();
      const [deleted] = await tx
        .update(capitalPurchases)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(eq(capitalPurchases.id, id), eq(capitalPurchases.accountId, accountId)))
        .returning();
      if (!deleted) return c.json({ error: 'purchase_not_found' }, 404);

      await c.var.audit({
        entityType: 'capital_purchase',
        entityId: id,
        action: 'delete',
        before: current,
        after: deleted,
        companyId: current.companyId,
      });

      // Soft delete keeps history; the reversal nets the purchase posting to
      // zero (same args reconstruct the original lines).
      await postCapitalPurchaseReversal(tx, {
        purchase: {
          id,
          amount: current.amount,
          paidNow: paidNowFor(current.funding, current.amount, current.downPayment),
          taxTreatment: current.taxTreatment as CapitalPurchaseTaxTreatment,
          description: current.description,
        },
        accountId,
        companyId: current.companyId,
        postedAt: expenseDateToPostedAt(current.purchaseDate),
      });

      return c.json(deleted);
    });
}

export type PurchasesAppType = ReturnType<typeof purchasesRoutes>;

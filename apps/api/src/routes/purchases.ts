import {
  capitalPurchases,
  chartOfAccounts,
  companies,
  contacts,
  journalEntries,
  journalLines,
} from '@thalermark/db';
import {
  type DepreciationConvention,
  capitalPurchaseCreateSchema,
  loanPaymentSchema,
} from '@thalermark/validation';
import { and, eq, getTableColumns, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { v7 as uuidv7 } from 'uuid';
import { depreciateOnce } from '../lib/depreciation.js';
import {
  type CapitalPurchaseTaxTreatment,
  type DepreciationPlan,
  depreciationPostedByYear,
  depreciationSchedule,
  loanBalance,
  postCapitalPurchase,
  postCapitalPurchaseReversal,
  postDepreciationReversal,
  postLoanPayment,
} from '../lib/ledger.js';
import { applyCursor, keysetOrderBy, parseLimit, slicePage } from '../lib/pagination.js';
import {
  UUID_RE,
  expenseDateToPostedAt,
  resolveMoneyAccount,
  resolveVendorLink,
  storedMoneyCode,
} from '../lib/route-helpers.js';
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
  return (
    new Hono<{ Variables: RlsVariables }>()
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

        const downPayment =
          rest.funding === 'paid_in_full' ? rest.amount : (rest.downPayment ?? '0');
        const paidNow = paidNowFor(rest.funding, rest.amount, downPayment);

        // Stored, because postCapitalPurchaseReversal re-derives its lines from
        // this row — a card-funded mower reversed against cash would credit the
        // card and debit checking, balanced and wrong.
        const money = await resolveMoneyAccount(tx, {
          accountId,
          companyId,
          moneyAccountId: rest.paymentAccountId,
        });
        if ('error' in money) return c.json({ error: money.error }, 400);

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
            paymentAccountId: money.id,
            taxTreatment: rest.taxTreatment,
            usefulLifeYears: rest.usefulLifeYears ?? 5,
            vendorContactId: vendorContactId ?? null,
            memo: rest.memo ?? null,
            // Both omitted for an ordinary purchase, which behaves exactly as
            // before. Set when the asset was already being depreciated somewhere
            // else — they only shift the schedule, never the purchase posting,
            // because a purchase entered here IS one this business paid for.
            priorAccumulatedDepreciation: rest.priorAccumulatedDepreciation ?? '0',
            depreciationStartYear: rest.depreciationStartYear ?? null,
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
            moneyCode: money.code,
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

        const conditions = [eq(capitalPurchases.accountId, accountId)];
        // Hidden unless asked for — see the same flag on GET /api/expenses.
        if (c.req.query('includeDeleted') !== 'true') {
          conditions.push(isNull(capitalPurchases.deletedAt));
        }
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
        // The plain "spread it out" answer. Null for the deduct-now path (already
        // fully written off at purchase).
        //
        // Planned against the company's convention so the figures shown here are
        // the same ones the sweeper posts — a user should never be told "$360 this
        // year" and then find $720 on line 13. `postedToDate` is what has actually
        // reached the ledger so far, which is also what makes the wait visible:
        // a year's depreciation posts once that year has closed, not on purchase.
        let schedule: (DepreciationPlan & { postedToDate: string }) | null = null;
        if (purchase.taxTreatment === 'spread') {
          const [company] = await tx
            .select({ convention: companies.depreciationConvention })
            .from(companies)
            .where(and(eq(companies.id, purchase.companyId), eq(companies.accountId, accountId)))
            .limit(1);
          const plan = depreciationSchedule(purchase.amount, purchase.usefulLifeYears, {
            convention: (company?.convention ?? 'half_year') as DepreciationConvention,
            purchaseYear: Number(purchase.purchaseDate.slice(0, 4)),
          });
          const postedByYear = await depreciationPostedByYear(tx, {
            accountId,
            companyId: purchase.companyId,
            purchaseId: id,
          });
          let postedCents = 0;
          for (const amount of postedByYear.values())
            postedCents += Math.round(Number(amount) * 100);
          schedule = { ...plan, postedToDate: (postedCents / 100).toFixed(2) };
        }

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
          const { amount, interest, paidOn, paymentAccountId } = c.req.valid('json');

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

          const loanMoney = await resolveMoneyAccount(tx, {
            accountId,
            companyId: purchase.companyId,
            moneyAccountId: paymentAccountId,
          });
          if ('error' in loanMoney) return c.json({ error: loanMoney.error }, 400);

          await postLoanPayment(tx, {
            purchaseId: id,
            description: purchase.description,
            amount,
            interest,
            moneyCode: loanMoney.code,
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
            Math.round(Number(current.amount) * 100) -
            Math.round(Number(current.downPayment) * 100);
          if (Math.round(Number(owing) * 100) !== financed) {
            return c.json({ error: 'has_payments' }, 409);
          }
        }

        const now = new Date();
        // isNull makes the UPDATE the guard — see the expenses delete. The
        // stakes are highest here: a racing second delete would reverse the
        // purchase AND every year of depreciation twice over.
        const [deleted] = await tx
          .update(capitalPurchases)
          .set({ deletedAt: now, updatedAt: now })
          .where(
            and(
              eq(capitalPurchases.id, id),
              eq(capitalPurchases.accountId, accountId),
              isNull(capitalPurchases.deletedAt),
            ),
          )
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

        // Any depreciation already swept in has to come off too, or a deleted
        // mower leaves Dr 6350 entries inflating Schedule C line 13 forever. Each
        // year is reversed at its own year-end so a filed year keeps the figure it
        // was filed with. Reversing beats blocking the delete: a purchase logged
        // three years ago should not become undeletable because a background job
        // touched it.
        const depreciated = await depreciationPostedByYear(tx, {
          accountId,
          companyId: current.companyId,
          purchaseId: id,
        });
        for (const [year, amount] of depreciated) {
          await postDepreciationReversal(tx, {
            purchaseId: id,
            description: current.description,
            year,
            amount,
            accountId,
            companyId: current.companyId,
          });
        }

        // Soft delete keeps history; the reversal nets the purchase posting to
        // zero (same args reconstruct the original lines).
        //
        // EXCEPT for a carried-over asset, which never had a create posting: it
        // arrived on these books through an opening balance (Dr 1500 / Cr 1900
        // against equity), not through capitalPurchaseLines' Dr 1500 / Cr Cash.
        // Reversing a posting that was never made would credit 1500 and DEBIT CASH
        // the business never received — inventing money. The depreciation reversal
        // above is still correct and still runs, because it only ever undoes what
        // this company actually posted.
        if (!current.transferredFromPurchaseId) {
          await postCapitalPurchaseReversal(tx, {
            purchase: {
              id,
              amount: current.amount,
              paidNow: paidNowFor(current.funding, current.amount, current.downPayment),
              taxTreatment: current.taxTreatment as CapitalPurchaseTaxTreatment,
              description: current.description,
              // The account the down payment actually left, resolved even if it
              // has since been archived.
              moneyCode: await storedMoneyCode(tx, {
                accountId,
                companyId: current.companyId,
                moneyAccountId: current.paymentAccountId,
              }),
            },
            accountId,
            companyId: current.companyId,
            postedAt: expenseDateToPostedAt(current.purchaseDate),
          });
        }

        return c.json(deleted);
      })
      // Undo the delete (TMC-240). The deepest of the three restores, because the
      // delete reversed two different things: the purchase posting and every year
      // of depreciation already swept in.
      //
      // The purchase posting is re-made here. The depreciation is not rebuilt by
      // hand — depreciateOnce recomputes "which closed years are missing from the
      // ledger?" from the ledger itself, so calling it puts back exactly the years
      // the delete took off, and nothing else. Calling it inline rather than
      // waiting for tomorrow's sweep matters: a restore that leaves line 13 wrong
      // until a background job runs is a restore the user cannot trust.
      .post('/api/purchases/:id/restore', requireCapability('expenses:write'), async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        const tx = c.get('tx');
        const accountId = c.get('accountId');

        const [current] = await tx
          .select()
          .from(capitalPurchases)
          .where(and(eq(capitalPurchases.id, id), eq(capitalPurchases.accountId, accountId)))
          .limit(1);
        if (!current) return c.json({ error: 'purchase_not_found' }, 404);
        // A live row is left alone rather than posted a second time.
        if (!current.deletedAt) return c.json(current);

        const [company] = await tx
          .select({
            convention: companies.depreciationConvention,
            timezone: companies.timezone,
          })
          .from(companies)
          .where(and(eq(companies.id, current.companyId), eq(companies.accountId, accountId)))
          .limit(1);
        if (!company) return c.json({ error: 'company_not_found' }, 404);

        const now = new Date();
        // Mirror of the delete's compare-and-swap: only the transaction that
        // clears the stamp reposts the purchase and re-runs depreciation.
        const [restored] = await tx
          .update(capitalPurchases)
          .set({ deletedAt: null, updatedAt: now })
          .where(
            and(
              eq(capitalPurchases.id, id),
              eq(capitalPurchases.accountId, accountId),
              isNotNull(capitalPurchases.deletedAt),
            ),
          )
          .returning();
        if (!restored) return c.json(current);

        await c.var.audit({
          entityType: 'capital_purchase',
          entityId: id,
          action: 'restore',
          before: current,
          after: restored,
          companyId: current.companyId,
        });

        // Mirror of the delete's skip: a carried-over asset never had a create
        // posting to reverse, so there is none to re-make either. Its cost is on
        // these books through an opening balance, which the delete left untouched.
        if (!restored.transferredFromPurchaseId) {
          await postCapitalPurchase(tx, {
            purchase: {
              id,
              amount: restored.amount,
              paidNow: paidNowFor(restored.funding, restored.amount, restored.downPayment),
              taxTreatment: restored.taxTreatment as CapitalPurchaseTaxTreatment,
              description: restored.description,
              // Restore is an undo: the entry goes back where it was, including
              // which account the down payment came out of.
              moneyCode: await storedMoneyCode(tx, {
                accountId,
                companyId: restored.companyId,
                moneyAccountId: restored.paymentAccountId,
              }),
            },
            accountId,
            companyId: restored.companyId,
            postedAt: expenseDateToPostedAt(restored.purchaseDate),
          });
        }

        if (restored.taxTreatment === 'spread') {
          await depreciateOnce(tx, {
            purchase: restored,
            convention: company.convention as DepreciationConvention,
            timezone: company.timezone,
            now,
          });
        }

        return c.json(restored);
      })
  );
}

export type PurchasesAppType = ReturnType<typeof purchasesRoutes>;

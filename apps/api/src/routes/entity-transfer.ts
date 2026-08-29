import {
  capitalPurchases,
  companies,
  entityTransfers,
  invoices,
  seedChartOfAccounts,
} from '@thalermark/db';
import { entityHandoffSchema, resolveCopyInclude } from '@thalermark/validation';
import { and, eq, isNull, lt } from 'drizzle-orm';
import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { v7 as uuidv7 } from 'uuid';
import { copyCompanyReferenceData, copyableProfile, targetIsEmpty } from '../lib/company-copy.js';
import {
  COA_AR,
  COA_OWNER_EQUITY,
  TRANSFER_IN_REVERSAL_SOURCE,
  TRANSFER_IN_SOURCE,
  TRANSFER_OUT_REVERSAL_SOURCE,
  TRANSFER_OUT_SOURCE,
  buildTransferPlan,
  createCarriedAssets,
  postTransferEntry,
  resolveLegs,
  reverseTransferEntries,
  successorActivity,
  transferEntries,
  transferLoanLegs,
  transferableAssets,
  transferableBalances,
} from '../lib/entity-transfer.js';
import { depreciationPostedByYear, postDepreciationReversal } from '../lib/ledger.js';
import { assertPeriodOpen } from '../lib/period-lock.js';
import { UUID_RE, expenseDateToPostedAt } from '../lib/route-helpers.js';
import { requireCapability } from '../middleware/authz.js';
import type { RlsVariables } from '../middleware/rls-context.js';

// entity-transfer — handing one business's books to another. A sole proprietor
// incorporates: the sole prop files a final Schedule C for the stub period, the
// corporation files its own return from the transfer date, and they are
// different taxpayers with different EINs.
//
// GET  /api/entity-transfers/preview?companyId= — what would move, uncommitted.
// POST /api/entity-transfers                     — do it, in ONE transaction.
// GET  /api/entity-transfers/current?companyId=  — did this company take over?
// POST /api/entity-transfers/:id/reverse         — undo it, also in one.
//
// Deliberately NOT under /api/companies/:id. Those paths already carry two
// sub-apps (CRUD and reports), and the web client facade intersects them by key;
// a third made hc's inference on the companies collection collapse, breaking
// every call site. A handoff is its own thing anyway, and the table agrees.
//
// The whole handoff is one tenant transaction: create the successor, seed its
// chart, copy the reference data, post both transfer entries, recreate the
// assets at carried basis, retire the predecessor. A failure anywhere leaves no
// half-created company.

export function entityTransferRoutes() {
  return (
    new Hono<{ Variables: RlsVariables }>()
      .get('/api/entity-transfers/preview', async (c) => {
        const id = c.req.query('companyId');
        if (!id || !UUID_RE.test(id)) return c.json({ error: 'invalid_company' }, 400);
        const tx = c.get('tx');
        const accountId = c.get('accountId');

        const [company] = await tx
          .select({ id: companies.id, timezone: companies.timezone })
          .from(companies)
          .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
          .limit(1);
        if (!company) return c.json({ error: 'company_not_found' }, 404);

        const effectiveDate = c.req.query('effectiveDate') ?? new Date().toISOString().slice(0, 10);
        const asOf = handoffInstant(effectiveDate);

        const balances = await transferableBalances(tx, { accountId, companyId: id, asOf });
        const assets = await transferableAssets(tx, { accountId, companyId: id });

        // Invoices already sent but unpaid — the question only the user can
        // answer, because both answers are legitimate and they produce different
        // opening balances.
        //
        // Bounded by the effective date for the same reason the balances are: an
        // invoice the old business issued AFTER the handover is not part of what
        // changed hands, and its receivable is not in the transferring balance
        // either. Listing one here and then not moving it is how the wizard came
        // to ask a question it silently ignored.
        const openInvoices = await tx
          .select({
            id: invoices.id,
            number: invoices.number,
            total: invoices.total,
            dueDate: invoices.dueDate,
          })
          .from(invoices)
          .where(
            and(
              eq(invoices.accountId, accountId),
              eq(invoices.companyId, id),
              eq(invoices.status, 'sent'),
              lt(invoices.issueDate, effectiveDate),
            ),
          );

        return c.json({
          effectiveDate,
          balances: balances.map((b) => ({
            code: b.code,
            name: b.name,
            accountType: b.accountType,
            // Signed, debit-positive — the raw shape the plan works in.
            amount: (b.raw / 100).toFixed(2),
          })),
          assets: assets.map((a) => ({
            id: a.purchase.id,
            description: a.purchase.description,
            cost: a.purchase.amount,
            accumulated: a.accumulated,
            outstandingLoan: a.outstandingLoan,
          })),
          openInvoices,
          openInvoicesTotal: openInvoices
            .reduce((sum, i) => sum + Math.round(Number(i.total) * 100), 0)
            .toString(),
        });
      })
      .post(
        '/api/entity-transfers',
        requireCapability('settings:manage'),
        validator('json', (value, c) => {
          const parsed = entityHandoffSchema.safeParse(value);
          if (!parsed.success) {
            return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
          }
          return parsed.data;
        }),
        async (c) => {
          const {
            predecessorCompanyId,
            name,
            businessType,
            effectiveDate,
            openInvoicesDisposition,
            transferAssetIds,
          } = c.req.valid('json');
          const include = resolveCopyInclude(c.req.valid('json').include);

          const tx = c.get('tx');
          const accountId = c.get('accountId');

          const [predecessor] = await tx
            .select()
            .from(companies)
            .where(and(eq(companies.id, predecessorCompanyId), eq(companies.accountId, accountId)))
            .limit(1);
          if (!predecessor) return c.json({ error: 'company_not_found' }, 404);
          if (predecessor.retiredAt) return c.json({ error: 'already_retired' }, 409);

          const postedAt = handoffInstant(effectiveDate);
          // Both sides, once, explicitly: the transfer entries write through the
          // lock-free primitive, so a handoff dated into a closed year would
          // otherwise slip behind the close.
          await assertPeriodOpen(tx, { accountId, companyId: predecessorCompanyId, postedAt });

          // --- The successor ------------------------------------------------------
          const successorCompanyId = uuidv7();
          await tx
            .insert(companies)
            .values({ id: successorCompanyId, accountId, name, businessType });
          await seedChartOfAccounts(tx, {
            accountId,
            companyId: successorCompanyId,
            businessType,
          });
          if (include.profile) {
            await tx
              .update(companies)
              .set(copyableProfile(predecessor))
              .where(eq(companies.id, successorCompanyId));
          }

          const scope = {
            accountId,
            sourceCompanyId: predecessorCompanyId,
            targetCompanyId: successorCompanyId,
          };
          if (!(await targetIsEmpty(tx, scope))) return c.json({ error: 'target_not_empty' }, 409);
          const copied = await copyCompanyReferenceData(tx, scope, include);

          // --- What moves ---------------------------------------------------------
          // A/R stays with the predecessor unless asked otherwise: the old business
          // billed the work, so the old business banks the cheque. Retirement
          // permits settlement precisely so it can (lib/company-lock.ts).
          const excludeCodes = openInvoicesDisposition === 'stay' ? [COA_AR] : [];
          const balances = await transferableBalances(tx, {
            accountId,
            companyId: predecessorCompanyId,
            asOf: postedAt,
            excludeCodes,
          });
          const plan = buildTransferPlan(balances);
          if (!plan) return c.json({ error: 'nothing_to_transfer' }, 409);

          const outLegs = await resolveLegs(tx, {
            accountId,
            companyId: predecessorCompanyId,
            legs: plan.legs,
            plugCode: '3900',
          });
          if ('unmapped' in outLegs) {
            return c.json({ error: 'transfer_account_unmapped', codes: outLegs.unmapped }, 409);
          }
          const inLegs = await resolveLegs(tx, {
            accountId,
            companyId: successorCompanyId,
            // Mirror: every leg flips side on the way in.
            legs: plan.legs.map((l) => ({
              ...l,
              side: l.side === 'debit' ? ('credit' as const) : ('debit' as const),
            })),
            plugCode: COA_OWNER_EQUITY,
          });
          if ('unmapped' in inLegs) {
            return c.json({ error: 'transfer_account_unmapped', codes: inLegs.unmapped }, 409);
          }

          const transferId = uuidv7();
          const outJournalEntryId = await postTransferEntry(tx, {
            accountId,
            companyId: predecessorCompanyId,
            transferId,
            lines: outLegs.lines,
            postedAt,
            sourceEntityType: TRANSFER_OUT_SOURCE,
            memo: `Business transferred to ${name}`,
          });
          const inJournalEntryId = await postTransferEntry(tx, {
            accountId,
            companyId: successorCompanyId,
            transferId,
            lines: inLegs.lines,
            postedAt,
            sourceEntityType: TRANSFER_IN_SOURCE,
            memo: `Business taken over from ${predecessor.name}`,
          });

          // --- Assets and their loans --------------------------------------------
          const allAssets = await transferableAssets(tx, {
            accountId,
            companyId: predecessorCompanyId,
          });
          const moving = transferAssetIds
            ? allAssets.filter((a) => transferAssetIds.includes(a.purchase.id))
            : allAssets;
          const assetIdMap = await createCarriedAssets(tx, {
            accountId,
            successorCompanyId,
            assets: moving,
            effectiveDate,
          });
          await transferLoanLegs(tx, {
            accountId,
            predecessorCompanyId,
            successorCompanyId,
            transferId,
            postedAt,
            loans: moving
              .filter((a) => Number(a.outstandingLoan) > 0)
              .map((a) => ({
                purchaseId: a.purchase.id,
                successorPurchaseId: assetIdMap.get(a.purchase.id) as string,
                outstanding: a.outstandingLoan,
              })),
          });

          // --- Wind the predecessor down -----------------------------------------
          // Schedules are ended explicitly rather than left to the sweep's retired
          // filter: this is customer-visible, and belt-and-braces is cheap.
          await tx
            .update(companies)
            .set({ retiredAt: new Date(), updatedAt: new Date() })
            .where(eq(companies.id, predecessorCompanyId));

          const [transfer] = await tx
            .insert(entityTransfers)
            .values({
              id: transferId,
              accountId,
              predecessorCompanyId,
              successorCompanyId,
              effectiveDate,
              openInvoicesDisposition,
              outJournalEntryId,
              inJournalEntryId,
              options: { include, transferAssetIds: moving.map((a) => a.purchase.id), copied },
            })
            .returning();

          // Audited on BOTH companies, so each activity feed tells its own half of
          // the story rather than the predecessor's simply going quiet.
          await c.var.audit({
            entityType: 'company',
            entityId: predecessorCompanyId,
            action: 'handoff-out',
            after: { transferId, successorCompanyId, effectiveDate },
            companyId: predecessorCompanyId,
          });
          await c.var.audit({
            entityType: 'company',
            entityId: successorCompanyId,
            action: 'handoff-in',
            after: { transferId, predecessorCompanyId, effectiveDate, copied },
            companyId: successorCompanyId,
          });

          return c.json(
            {
              transferId: transfer?.id ?? transferId,
              successorCompanyId,
              predecessorCompanyId,
              effectiveDate,
              netAssets: plan.netAssets,
              assetsTransferred: moving.length,
              copied,
            },
            201,
          );
        },
      )
      // Did this company take over from another, and can that still be undone?
      // Powers the undo panel on the successor's settings page — which is where a
      // user who has just realised the handoff was wrong will go looking.
      .get('/api/entity-transfers/current', async (c) => {
        const id = c.req.query('companyId');
        if (!id || !UUID_RE.test(id)) return c.json({ error: 'invalid_company' }, 400);
        const tx = c.get('tx');
        const accountId = c.get('accountId');

        const [transfer] = await tx
          .select()
          .from(entityTransfers)
          .where(
            and(
              eq(entityTransfers.accountId, accountId),
              eq(entityTransfers.successorCompanyId, id),
              isNull(entityTransfers.reversedAt),
            ),
          )
          .limit(1);
        if (!transfer) return c.json({ transfer: null });

        const [predecessor] = await tx
          .select({ id: companies.id, name: companies.name })
          .from(companies)
          .where(eq(companies.id, transfer.predecessorCompanyId))
          .limit(1);

        // Told rather than discovered: the page can say "you've recorded work
        // against this business, so it can't be undone" up front, instead of
        // offering a button that 409s.
        const activity = await successorActivity(tx, { accountId, companyId: id });

        return c.json({
          transfer: {
            id: transfer.id,
            effectiveDate: transfer.effectiveDate,
            predecessorCompanyId: transfer.predecessorCompanyId,
            predecessorName: predecessor?.name ?? null,
            reversible: activity.length === 0,
            activity,
          },
        });
      })
      // Undo a handoff. Append-only like every other reversal here: mirror entries,
      // never deletions — that a handoff happened and was undone is itself history.
      .post(
        '/api/entity-transfers/:id/reverse',
        requireCapability('settings:manage'),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
          const tx = c.get('tx');
          const accountId = c.get('accountId');

          const [transfer] = await tx
            .select()
            .from(entityTransfers)
            .where(and(eq(entityTransfers.id, id), eq(entityTransfers.accountId, accountId)))
            .limit(1);
          if (!transfer) return c.json({ error: 'transfer_not_found' }, 404);
          if (transfer.reversedAt) return c.json({ error: 'already_reversed' }, 409);

          const { predecessorCompanyId, successorCompanyId } = transfer;

          // Refuse if the successor has traded. Reversing a handoff out from under
          // real work would leave those invoices and expenses on a company with no
          // opening position — a balance sheet that cannot be explained.
          const activity = await successorActivity(tx, {
            accountId,
            companyId: successorCompanyId,
          });
          if (activity.length > 0) {
            return c.json({ error: 'successor_has_activity', sources: activity }, 409);
          }

          const postedAt = handoffInstant(transfer.effectiveDate);
          await assertPeriodOpen(tx, { accountId, companyId: predecessorCompanyId, postedAt });
          await assertPeriodOpen(tx, { accountId, companyId: successorCompanyId, postedAt });

          // --- Depreciation the sweep posted on carried assets --------------------
          // Undone rather than refused: the sweep runs nightly without anyone asking,
          // and a machine-generated entry must not be able to take the undo away
          // overnight. Reversed BEFORE the successor is retired, since these post
          // through the locking path.
          const carried = await tx
            .select()
            .from(capitalPurchases)
            .where(
              and(
                eq(capitalPurchases.accountId, accountId),
                eq(capitalPurchases.companyId, successorCompanyId),
                isNull(capitalPurchases.deletedAt),
              ),
            );
          let depreciationReversed = 0;
          for (const purchase of carried) {
            const posted = await depreciationPostedByYear(tx, {
              accountId,
              companyId: successorCompanyId,
              purchaseId: purchase.id,
            });
            for (const [year, amount] of posted) {
              if (Number(amount) === 0) continue;
              await postDepreciationReversal(tx, {
                accountId,
                companyId: successorCompanyId,
                purchaseId: purchase.id,
                description: purchase.description,
                year,
                amount,
              });
              depreciationReversed += 1;
            }
          }

          // --- Both sides of the handoff -----------------------------------------
          const outEntries = await transferEntries(tx, {
            accountId,
            companyId: predecessorCompanyId,
            sourceEntityType: TRANSFER_OUT_SOURCE,
          });
          const inEntries = await transferEntries(tx, {
            accountId,
            companyId: successorCompanyId,
            sourceEntityType: TRANSFER_IN_SOURCE,
          });
          await reverseTransferEntries(tx, {
            accountId,
            companyId: predecessorCompanyId,
            entries: outEntries,
            sourceEntityType: TRANSFER_OUT_REVERSAL_SOURCE,
            memo: 'Business transfer undone',
          });
          await reverseTransferEntries(tx, {
            accountId,
            companyId: successorCompanyId,
            entries: inEntries,
            sourceEntityType: TRANSFER_IN_REVERSAL_SOURCE,
            memo: 'Business takeover undone',
          });

          // --- Put the two companies back -----------------------------------------
          const now = new Date();
          if (carried.length > 0) {
            await tx
              .update(capitalPurchases)
              .set({ deletedAt: now, updatedAt: now })
              .where(
                and(
                  eq(capitalPurchases.accountId, accountId),
                  eq(capitalPurchases.companyId, successorCompanyId),
                  isNull(capitalPurchases.deletedAt),
                ),
              );
          }
          await tx
            .update(companies)
            .set({ retiredAt: null, updatedAt: now })
            .where(eq(companies.id, predecessorCompanyId));
          // The successor is retired, not deleted. Its ledger nets to zero and it
          // still holds the copied contacts and prices, but deleting a company would
          // delete journal entries — and an append-only ledger is the one promise
          // this product cannot walk back. It closes the same way any other business
          // that stopped trading does.
          await tx
            .update(companies)
            .set({ retiredAt: now, updatedAt: now })
            .where(eq(companies.id, successorCompanyId));
          await tx
            .update(entityTransfers)
            .set({ reversedAt: now, updatedAt: now })
            .where(eq(entityTransfers.id, id));

          await c.var.audit({
            entityType: 'company',
            entityId: predecessorCompanyId,
            action: 'handoff-out-reversed',
            after: { transferId: id, successorCompanyId },
            companyId: predecessorCompanyId,
          });
          await c.var.audit({
            entityType: 'company',
            entityId: successorCompanyId,
            action: 'handoff-in-reversed',
            after: { transferId: id, predecessorCompanyId },
            companyId: successorCompanyId,
          });

          return c.json({
            transferId: id,
            reversedAt: now.toISOString(),
            predecessorCompanyId,
            successorCompanyId,
            entriesReversed: outEntries.length + inEntries.length,
            depreciationReversed,
            assetsReturned: carried.length,
          });
        },
      )
  );
}

export type EntityTransferAppType = ReturnType<typeof entityTransferRoutes>;

// The instant the successor takes over: the start of the effective date. Both
// entries post here, so the predecessor's balance sheet the day before is its
// last trading position and the successor's opening position is this.
function handoffInstant(effectiveDate: string): Date {
  return expenseDateToPostedAt(effectiveDate);
}

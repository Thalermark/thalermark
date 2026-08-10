import {
  type CapitalPurchase,
  type Database,
  SYSTEM_USER_ID,
  type Transaction,
  capitalPurchases,
  companies,
  withAccountContext,
} from '@thalermark/db';
import { getLogger } from '@thalermark/logger';
import type { DepreciationConvention } from '@thalermark/validation';
import { and, eq, isNull } from 'drizzle-orm';
import { createAuditWriter } from '../middleware/audit.js';
import { depreciationPostedByYear, depreciationSchedule, postDepreciation } from './ledger.js';

const log = getLogger(['api', 'depreciation']);

// Yearly depreciation for "spread it out" purchases (TMC-123).
//
// A user who picks "spread it out" instead of "deduct it all this year" was, up
// to this point, shown a schedule that nothing ever posted — so their Schedule C
// line 13 read $0 forever. That's a wrong number on a shipped tax worksheet, not
// a missing background job, which is why this backfills rather than starting
// from today. §179 purchases are unaffected: their whole write-off posts at
// purchase time.
//
// Depreciation is basis-independent — cash filers take it too, and cash-basis
// Schedule C reads expenses straight off the GL — so the accounting-method
// toggle neither causes nor mitigates any of this.
//
// Modeled on lib/recurring.ts: scan every tenant on the bootstrap (BYPASSRLS)
// handle, then post each purchase inside its own tenant transaction so every
// write is RLS-correct and attributed to the system user.

// A year is depreciable once it's over. Comparing against the *company's* local
// year matters at the boundary: on 1 Jan at 02:00 UTC a company in
// America/Chicago is still in the old year, and posting its year-end before it
// has actually ended would put a deduction on a tax year the operator hasn't
// finished living through.
function localYear(tz: string, now: Date): number {
  return Number(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric' }).format(now));
}

export type PurchaseDepreciationResult = { posted: number; amount: string };

// Post every depreciation year that has closed and isn't on the books yet, for
// ONE purchase, inside an existing tenant transaction. Idempotent: the already-
// posted years are read back from the ledger, so a re-run posts nothing and a
// purchase from three years ago catches up in a single pass.
export async function depreciateOnce(
  tx: Transaction,
  args: {
    purchase: Pick<
      CapitalPurchase,
      | 'id'
      | 'accountId'
      | 'companyId'
      | 'amount'
      | 'purchaseDate'
      | 'usefulLifeYears'
      | 'description'
      | 'priorAccumulatedDepreciation'
      | 'depreciationStartYear'
    >;
    convention: DepreciationConvention;
    timezone: string;
    now?: Date;
  },
): Promise<PurchaseDepreciationResult> {
  const { purchase } = args;
  const now = args.now ?? new Date();
  const scope = { accountId: purchase.accountId, companyId: purchase.companyId };
  const purchaseYear = Number(purchase.purchaseDate.slice(0, 4));
  const currentYear = localYear(args.timezone, now);

  // The plan is deliberately unchanged for a carried-over asset. §351 carryover
  // basis means the successor steps into the transferor's shoes — same cost,
  // same life, same convention, same clock — so the schedule computed here is
  // byte-identical to the one the previous books were working through. Only
  // WHICH of its years belong to this company differs.
  const plan = depreciationSchedule(purchase.amount, purchase.usefulLifeYears, {
    convention: args.convention,
    purchaseYear,
  });
  const postedByYear = await depreciationPostedByYear(tx, { ...scope, purchaseId: purchase.id });

  // Null start year = an ordinary purchase, whose first year is its purchase
  // year. That is exactly the pre-existing behaviour, so nothing changes for the
  // rows that predate this.
  const startYear = purchase.depreciationStartYear ?? purchaseYear;

  const totalCents = Math.round(Number(plan.total) * 100);
  // Seed the clamp with what was written off on the OTHER books. Without this a
  // carried-over asset could be depreciated for more than it ever cost, across
  // the two sets of books combined.
  let postedCents = Math.round(Number(purchase.priorAccumulatedDepreciation ?? '0') * 100);
  for (const amount of postedByYear.values()) postedCents += Math.round(Number(amount) * 100);

  let posted = 0;
  let addedCents = 0;
  for (const [index, row] of plan.rows.entries()) {
    // Only closed years. A purchase made this year posts nothing until January.
    if (row.year >= currentYear) break;
    // Years that belong to the previous books. Without this the sweep would
    // back-post the asset's entire prior history into a company that never
    // owned it during those years.
    if (row.year < startYear) continue;
    // Years already on the books. "On the books" is the year's NET, not whether
    // it has entries: a purchase that was deleted and then restored (TMC-240)
    // has last year's depreciation AND its reversal, which sum to zero. Nothing
    // is deducted for that year, so it has to post again — which is what
    // depreciationPostedByYear has always documented it returns 0.00 for.
    if (Math.round(Number(postedByYear.get(row.year) ?? '0') * 100) !== 0) continue;

    let cents = Math.round(Number(row.amount) * 100);
    // An accountant flipping the convention mid-life leaves years already posted
    // on the old plan (the ledger is append-only — we never rewrite them). Clamp
    // so the asset can't be written off for more than it cost, and let the final
    // planned year absorb any shortfall the flip left behind, so it still ends
    // fully depreciated.
    if (index === plan.rows.length - 1) {
      cents = totalCents - postedCents - addedCents;
    }
    cents = Math.min(cents, totalCents - postedCents - addedCents);
    if (cents <= 0) continue;

    await postDepreciation(tx, {
      purchaseId: purchase.id,
      description: purchase.description,
      year: row.year,
      amount: (cents / 100).toFixed(2),
      accountId: purchase.accountId,
      companyId: purchase.companyId,
    });
    posted += 1;
    addedCents += cents;
  }

  return { posted, amount: (addedCents / 100).toFixed(2) };
}

export type DepreciationSweepResult = {
  candidates: number;
  purchasesPosted: number;
  entriesPosted: number;
  failed: number;
};

// Scan ALL tenants for "spread it out" purchases with unposted closed years and
// post them. Runs daily rather than yearly on purpose: the backfill has to fire
// on the first run after deploy whatever the date, and a purchase logged today
// but dated three years ago needs its history immediately. On every other day
// it reads the ledger, finds nothing owing, and writes nothing.
//
// Deliberately NOT entitlement-gated, unlike the recurring-invoice sweep.
// Recurring generation is a freeze door — a lapsed account must stop emailing
// invoices. Depreciation is bookkeeping accuracy: skipping it wouldn't withhold
// a feature, it would silently put a wrong number on the account's tax form and
// leave a gap in the ledger that only another posting can repair.
export async function sweepDepreciation(args: {
  bootstrapDb: Database;
  tenantDb: Database;
  now?: Date;
}): Promise<DepreciationSweepResult> {
  const now = args.now ?? new Date();

  // The company join carries the two per-company inputs: the convention to plan
  // against, and the zone that decides whether a year has actually closed.
  const candidates = await args.bootstrapDb
    .select({
      purchase: capitalPurchases,
      convention: companies.depreciationConvention,
      timezone: companies.timezone,
    })
    .from(capitalPurchases)
    .innerJoin(companies, eq(companies.id, capitalPurchases.companyId))
    .where(
      and(
        eq(capitalPurchases.taxTreatment, 'spread'),
        isNull(capitalPurchases.deletedAt),
        // A retired company's books take no new postings, so its purchases would
        // fail the lock and be logged as an error on every daily run forever.
        // Skipping them here keeps the sweep quiet and is also just correct: a
        // business that has stopped trading stops depreciating.
        isNull(companies.retiredAt),
      ),
    );

  let purchasesPosted = 0;
  let entriesPosted = 0;
  let failed = 0;
  for (const row of candidates) {
    try {
      const result = await withAccountContext(
        args.tenantDb,
        { accountId: row.purchase.accountId },
        async (tx) => {
          const audit = createAuditWriter({
            tx,
            accountId: row.purchase.accountId,
            actorUserId: SYSTEM_USER_ID,
            onWrite: () => {},
          });
          const posted = await depreciateOnce(tx, {
            purchase: row.purchase,
            convention: row.convention as DepreciationConvention,
            timezone: row.timezone,
            now,
          });
          if (posted.posted > 0) {
            await audit({
              entityType: 'capital_purchase',
              entityId: row.purchase.id,
              action: 'depreciation',
              after: { years: posted.posted, amount: posted.amount },
              companyId: row.purchase.companyId,
            });
          }
          return posted;
        },
      );
      if (result.posted > 0) {
        purchasesPosted += 1;
        entriesPosted += result.posted;
      }
    } catch (err) {
      // One purchase failing is logged and skipped — its years stay unposted and
      // the next sweep retries them, because "which years are missing" is
      // recomputed from the ledger every run rather than tracked as state.
      failed += 1;
      log.error('depreciation sweep failed for purchase {id}: {msg}', {
        id: row.purchase.id,
        msg: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (entriesPosted > 0 || failed > 0) {
    log.info(
      'depreciation sweep: {entriesPosted} entries across {purchasesPosted} purchases ({failed} failed, {candidates} scanned)',
      { entriesPosted, purchasesPosted, failed, candidates: candidates.length },
    );
  }
  return { candidates: candidates.length, purchasesPosted, entriesPosted, failed };
}

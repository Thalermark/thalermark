/**
 * Load-test data seeder — stands up a large, *ledger-correct* dataset for
 * query-performance testing.
 *
 * Why direct-to-DB and not the API: going through HTTP + auth + validation +
 * per-row ledger lookups is 100–1000× slower; we want hundreds of thousands of
 * rows in minutes. The catch is the hidden double-entry ledger — every sent /
 * paid / voided invoice and every expense posts balanced journal entries, and
 * the dashboard / trial balance / cash-flow / AR / top-products queries all
 * read the ledger. So this seeder reuses the *pure* posting helpers
 * (`invoicePostingLines` / `expensePostingLines`) to emit the same journal
 * entries the API would, keeping the books balanced and the aggregate queries
 * realistic. (The balance trigger is deferred to commit; each entry we emit is
 * balanced, so batching is safe.)
 *
 * It seeds into an EXISTING account so there's a real, loginable user + a real
 * COA, and the data shows up in the app/web under the real RLS path. Sign up
 * normally first, then point the seeder at that account.
 *
 * Connects as the superuser `DATABASE_URL` (bypasses RLS for the cross-row
 * bulk insert). Benchmark the *reads* with bench-reads.ts, which connects as
 * the `thalermark_app` role so RLS overhead is measured.
 *
 *   pnpm --filter @thalermark/api seed:load-test -- \
 *     --email you@example.com --invoices 100000 --expenses 50000 --yes
 *
 * Flags (all optional except the target + --yes):
 *   --email <addr> | --company <uuid>   target (else: first company, warns)
 *   --invoices N    (default 50000)     --expenses N   (default 20000)
 *   --estimates N   (default 5000)      --customers N  (default 500)
 *   --items N       (default 100)       --months N     (date spread, default 24)
 *   --yes                               required to actually write
 */
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import {
  type Database,
  SYSTEM_USER_ID,
  type Transaction,
  auditEvents,
  authUser,
  chartOfAccounts,
  companies,
  createDatabase,
  customers,
  estimateLineItems,
  estimates,
  expenses,
  invoiceLineItems,
  invoices,
  items,
  journalEntries,
  journalLines,
  memberships,
} from '@thalermark/db';
import { asc, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { type LedgerLine, expensePostingLines, invoicePostingLines } from '../src/lib/ledger.js';

loadEnvFile(resolve(import.meta.dirname, '../../../.env'));

// ---- args ----------------------------------------------------------------
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);
const num = (name: string, dflt: number) => {
  const v = arg(name);
  return v === undefined ? dflt : Math.max(0, Number.parseInt(v, 10) || 0);
};

const cfg = {
  email: arg('email'),
  company: arg('company'),
  invoices: num('invoices', 50_000),
  expenses: num('expenses', 20_000),
  estimates: num('estimates', 5_000),
  customers: num('customers', 500),
  items: num('items', 100),
  months: num('months', 24),
  confirmed: flag('yes'),
};

// ---- rng / generators (no faker dep) -------------------------------------
const FIRST = [
  'Ava',
  'Liam',
  'Mia',
  'Noah',
  'Zoe',
  'Eli',
  'Ivy',
  'Kai',
  'Luna',
  'Max',
  'Nora',
  'Owen',
  'Ruby',
  'Sam',
  'Tess',
];
const LAST = [
  'Stone',
  'Vale',
  'Brooks',
  'Hale',
  'Reyes',
  'Quinn',
  'Frost',
  'Mercer',
  'Bly',
  'Crane',
  'Dunn',
  'Webb',
  'Yates',
  'Pike',
  'Lowe',
];
const BIZ = [
  'Maple',
  'Granite',
  'Harbor',
  'Cedar',
  'Ironwood',
  'Brightleaf',
  'Riverbend',
  'Summit',
  'Hollow',
  'Copperline',
];
const ITEM_WORDS = [
  'Standard',
  'Premium',
  'Spring',
  'Emergency',
  'Monthly',
  'Deep',
  'Seasonal',
  'Express',
];
const ITEM_KIND = [
  'Service Call',
  'Cleanup',
  'Inspection',
  'Tune-up',
  'Repair',
  'Install',
  'Maintenance',
  'Consultation',
];
const MERCHANTS = [
  'Home Depot',
  'Lowes',
  'Shell',
  'Costco',
  'Amazon',
  'Grainger',
  'Ace Hardware',
  'Sunoco',
  'Staples',
  'Uline',
];

const pick = <T>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)] as T;
const randInt = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));
const money = (n: number) => n.toFixed(2);
const DAY = 86_400_000;

// A timestamp uniformly within the last `months`.
function spreadDate(months: number): Date {
  return new Date(Date.now() - Math.random() * months * 30 * DAY);
}
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);
const clampNow = (d: Date) => (d.getTime() > Date.now() ? new Date() : d);

// ---- chunked bulk insert -------------------------------------------------
// Postgres caps bind params ~65535; keep chunks well under (≤1000 rows × cols).
async function bulkInsert<T>(
  tx: Transaction,
  // biome-ignore lint/suspicious/noExplicitAny: drizzle table + row typing varies per call site
  table: any,
  rows: T[],
  chunk = 1000,
): Promise<void> {
  for (let i = 0; i < rows.length; i += chunk) {
    await tx.insert(table).values(rows.slice(i, i + chunk));
  }
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL is required');
  const db: Database = createDatabase(dbUrl);

  // ---- resolve the target company + an actor user ----
  const company = await resolveCompany(db);
  const actorUserId = await resolveActor(db, company.accountId);

  // ---- prefetch the company COA (code → id, by type) ----
  const coaRows = await db
    .select({
      id: chartOfAccounts.id,
      code: chartOfAccounts.code,
      type: chartOfAccounts.accountType,
    })
    .from(chartOfAccounts)
    .where(eq(chartOfAccounts.companyId, company.id));
  if (coaRows.length === 0) {
    throw new Error(
      `company ${company.id} has no chart of accounts — sign up seeds it; is this a real company?`,
    );
  }
  const coaId = new Map(coaRows.map((r) => [r.code, r.id]));
  const expenseCodes = coaRows.filter((r) => r.type === 'expense').map((r) => r.code);
  const paymentCode = coaId.has('1000')
    ? '1000'
    : (coaRows.find((r) => r.type === 'asset')?.code ?? '1000');

  console.log('Load-test seed target:');
  console.log(`  db        ${redactUrl(dbUrl)}`);
  console.log(`  account   ${company.accountId}`);
  console.log(`  company   ${company.name} (${company.id})`);
  console.log(`  actor     ${actorUserId}`);
  console.log(
    `  plan      ${cfg.customers} customers · ${cfg.items} items · ${cfg.invoices} invoices · ${cfg.expenses} expenses · ${cfg.estimates} estimates · dates over ${cfg.months}mo`,
  );
  if (!cfg.confirmed) {
    console.log('\nDry run — pass --yes to write. Nothing inserted.');
    await process.exit(0);
  }
  console.log('\nSeeding…');
  const started = Date.now();

  const scope = { accountId: company.accountId, companyId: company.id };

  // ---- customers + items (created first; invoices/expenses reference them) ----
  const customerIds: string[] = [];
  const customerRows = Array.from({ length: cfg.customers }, () => {
    const id = uuidv7();
    customerIds.push(id);
    const created = spreadDate(cfg.months);
    const name = `${pick(FIRST)} ${pick(LAST)}`;
    return {
      id,
      ...scope,
      name,
      email: `${name.toLowerCase().replace(/[^a-z]+/g, '.')}.${randInt(1, 9999)}@example.com`,
      phone: `555-${String(randInt(1000, 9999))}`,
      city: pick(BIZ),
      region: 'CA',
      country: 'US',
      createdAt: created,
      updatedAt: created,
    };
  });

  const itemPool: { id: string; unitPrice: number; description: string }[] = [];
  const itemRows = Array.from({ length: cfg.items }, () => {
    const id = uuidv7();
    const unitPrice = randInt(20, 600) + 0.0;
    const description = `${pick(ITEM_WORDS)} ${pick(ITEM_KIND)}`;
    itemPool.push({ id, unitPrice, description });
    const created = spreadDate(cfg.months);
    return {
      id,
      ...scope,
      name: description,
      description,
      unitPrice: money(unitPrice),
      defaultQuantity: '1',
      createdAt: created,
      updatedAt: created,
    };
  });

  await db.transaction(async (tx) => {
    await bulkInsert(tx, customers, customerRows);
    await bulkInsert(tx, items, itemRows);
  });
  console.log(`  ✓ ${cfg.customers} customers, ${cfg.items} items`);

  // ---- invoices (+ line items + ledger + audit) ----
  // Per-company invoice numbers must be unique (invoices_company_number_uq);
  // continue past any that already exist on the company.
  let invSeq = (await maxNumberSeq(db, 'invoice', company.id)) + 1;
  await batched(cfg.invoices, 2000, async (count, base) => {
    const inv: (typeof invoices.$inferInsert)[] = [];
    const lines: (typeof invoiceLineItems.$inferInsert)[] = [];
    const entries: (typeof journalEntries.$inferInsert)[] = [];
    const jlines: (typeof journalLines.$inferInsert)[] = [];
    const audits: (typeof auditEvents.$inferInsert)[] = [];

    for (let k = 0; k < count; k++) {
      const id = uuidv7();
      const issued = spreadDate(cfg.months);
      const status = weightedStatus();
      const number = `INV-${String(invSeq++).padStart(6, '0')}`;

      // 1–5 lines, mix of catalogued + hand-typed.
      const nLines = randInt(1, 5);
      let subtotalN = 0;
      for (let p = 1; p <= nLines; p++) {
        const fromCatalog = Math.random() < 0.7 && itemPool.length > 0;
        const src = fromCatalog ? pick(itemPool) : null;
        const qty = randInt(1, 8);
        const unit = src ? src.unitPrice : randInt(15, 400);
        const amt = unit * qty;
        subtotalN += amt;
        lines.push({
          id: uuidv7(),
          accountId: scope.accountId,
          invoiceId: id,
          position: p,
          description: src ? src.description : `${pick(ITEM_WORDS)} ${pick(ITEM_KIND)}`,
          quantity: String(qty),
          unitPrice: money(unit),
          amount: money(amt),
          sourceItemId: src ? src.id : null,
          createdAt: issued,
          updatedAt: issued,
        });
      }
      const taxN = Math.random() < 0.5 ? Math.round(subtotalN * 0.0725 * 100) / 100 : 0;
      const totalN = subtotalN + taxN;
      // Load-test rows are all-service (productSubtotal 0) — the revenue split
      // is exercised by the integration tests, not the bulk seed.
      const amounts = {
        subtotal: money(subtotalN),
        productSubtotal: money(0),
        tax: money(taxN),
        total: money(totalN),
      };

      const sentAt = ['sent', 'paid', 'voided'].includes(status)
        ? clampNow(addDays(issued, randInt(0, 2)))
        : null;
      const paidAt = status === 'paid' ? clampNow(addDays(issued, randInt(1, 45))) : null;
      const voidedAt = status === 'voided' ? clampNow(addDays(issued, randInt(1, 20))) : null;

      inv.push({
        id,
        ...scope,
        customerId: pick(customerIds),
        number,
        status,
        issueDate: isoDay(issued),
        dueDate: isoDay(addDays(issued, 30)),
        subtotal: amounts.subtotal,
        tax: amounts.tax,
        total: amounts.total,
        sentAt,
        paidAt,
        voidedAt,
        publicToken: status === 'draft' ? null : uuidv7(),
        createdAt: issued,
        updatedAt: sentAt ?? issued,
      });

      // Ledger — mirror the lifecycle the API would have posted.
      const post = (prev: 'draft' | 'sent', next: 'sent' | 'paid' | 'voided', at: Date) => {
        pushEntry(entries, jlines, scope, coaId, {
          sourceEntityId: id,
          memo: `invoice ${number} ${next}`,
          postedAt: at,
          lines: invoicePostingLines(prev, next, amounts),
        });
      };
      if (status === 'sent' && sentAt) post('draft', 'sent', sentAt);
      if (status === 'paid' && sentAt && paidAt) {
        post('draft', 'sent', sentAt);
        post('sent', 'paid', paidAt);
      }
      if (status === 'voided' && sentAt && voidedAt) {
        post('draft', 'sent', sentAt);
        post('sent', 'voided', voidedAt);
      }

      // Audit trail (powers the activity feed at volume).
      const audit = (action: string, at: Date) =>
        audits.push({
          id: uuidv7(),
          accountId: scope.accountId,
          companyId: scope.companyId,
          actorUserId,
          entityType: 'invoice',
          entityId: id,
          action,
          before: null,
          after: { number, status },
          createdAt: at,
        });
      audit('create', issued);
      if (sentAt) audit('mark-sent', sentAt);
      if (paidAt) audit('mark-paid', paidAt);
      if (voidedAt) audit('void', voidedAt);
    }

    await db.transaction(async (tx) => {
      await bulkInsert(tx, invoices, inv);
      await bulkInsert(tx, invoiceLineItems, lines);
      await bulkInsert(tx, journalEntries, entries);
      await bulkInsert(tx, journalLines, jlines);
      await bulkInsert(tx, auditEvents, audits);
    });
    process.stdout.write(`\r  … invoices ${base + count}/${cfg.invoices}`);
  });
  if (cfg.invoices > 0) console.log('');

  // ---- expenses (+ ledger + audit) ----
  await batched(cfg.expenses, 4000, async (count, base) => {
    const exp: (typeof expenses.$inferInsert)[] = [];
    const entries: (typeof journalEntries.$inferInsert)[] = [];
    const jlines: (typeof journalLines.$inferInsert)[] = [];
    const audits: (typeof auditEvents.$inferInsert)[] = [];

    for (let k = 0; k < count; k++) {
      const id = uuidv7();
      const when = spreadDate(cfg.months);
      const amountN = randInt(5, 1200) + Math.round(Math.random() * 99) / 100;
      const categoryCode = expenseCodes.length > 0 ? pick(expenseCodes) : '';
      const amount = money(amountN);
      exp.push({
        id,
        ...scope,
        categoryAccountId: coaId.get(categoryCode) as string,
        paymentAccountId: coaId.get(paymentCode) as string,
        amount,
        expenseDate: isoDay(when),
        merchant: pick(MERCHANTS),
        createdAt: when,
        updatedAt: when,
      });
      if (categoryCode) {
        pushEntry(entries, jlines, scope, coaId, {
          sourceEntityId: id,
          memo: `expense ${id}`,
          postedAt: when,
          lines: expensePostingLines({ categoryCode, paymentCode, amount }),
        });
      }
      audits.push({
        id: uuidv7(),
        accountId: scope.accountId,
        companyId: scope.companyId,
        actorUserId,
        entityType: 'expense',
        entityId: id,
        action: 'create',
        before: null,
        after: { amount },
        createdAt: when,
      });
    }

    await db.transaction(async (tx) => {
      await bulkInsert(tx, expenses, exp);
      await bulkInsert(tx, journalEntries, entries);
      await bulkInsert(tx, journalLines, jlines);
      await bulkInsert(tx, auditEvents, audits);
    });
    process.stdout.write(`\r  … expenses ${base + count}/${cfg.expenses}`);
  });
  if (cfg.expenses > 0) console.log('');

  // ---- estimates (+ line items; no ledger — estimates don't post) ----
  let estSeq = (await maxNumberSeq(db, 'estimate', company.id)) + 1;
  await batched(cfg.estimates, 2000, async (count, base) => {
    const est: (typeof estimates.$inferInsert)[] = [];
    const lines: (typeof estimateLineItems.$inferInsert)[] = [];
    const audits: (typeof auditEvents.$inferInsert)[] = [];
    for (let k = 0; k < count; k++) {
      const id = uuidv7();
      const issued = spreadDate(cfg.months);
      const number = `EST-${String(estSeq++).padStart(6, '0')}`;
      const status = pick(['draft', 'sent', 'accepted', 'declined'] as const);
      const nLines = randInt(1, 4);
      let subtotalN = 0;
      for (let p = 1; p <= nLines; p++) {
        const src = Math.random() < 0.7 && itemPool.length > 0 ? pick(itemPool) : null;
        const qty = randInt(1, 6);
        const unit = src ? src.unitPrice : randInt(15, 400);
        const amt = unit * qty;
        subtotalN += amt;
        lines.push({
          id: uuidv7(),
          accountId: scope.accountId,
          estimateId: id,
          position: p,
          description: src ? src.description : `${pick(ITEM_WORDS)} ${pick(ITEM_KIND)}`,
          quantity: String(qty),
          unitPrice: money(unit),
          amount: money(amt),
          sourceItemId: src ? src.id : null,
          createdAt: issued,
          updatedAt: issued,
        });
      }
      est.push({
        id,
        ...scope,
        customerId: pick(customerIds),
        number,
        status,
        issueDate: isoDay(issued),
        expiresOn: isoDay(addDays(issued, 30)),
        subtotal: money(subtotalN),
        tax: '0',
        total: money(subtotalN),
        publicToken: status === 'draft' ? null : uuidv7(),
        createdAt: issued,
        updatedAt: issued,
      });
      audits.push({
        id: uuidv7(),
        accountId: scope.accountId,
        companyId: scope.companyId,
        actorUserId,
        entityType: 'estimate',
        entityId: id,
        action: 'create',
        before: null,
        after: { number, status },
        createdAt: issued,
      });
    }
    await db.transaction(async (tx) => {
      await bulkInsert(tx, estimates, est);
      await bulkInsert(tx, estimateLineItems, lines);
      await bulkInsert(tx, auditEvents, audits);
    });
    process.stdout.write(`\r  … estimates ${base + count}/${cfg.estimates}`);
  });
  if (cfg.estimates > 0) console.log('');

  console.log(
    `\nDone in ${((Date.now() - started) / 1000).toFixed(1)}s. Bench reads with: pnpm --filter @thalermark/api bench:reads -- --company ${company.id}`,
  );
  await process.exit(0);
}

// ---- helpers -------------------------------------------------------------

function weightedStatus(): 'draft' | 'sent' | 'paid' | 'voided' {
  const r = Math.random();
  if (r < 0.15) return 'draft';
  if (r < 0.4) return 'sent';
  if (r < 0.95) return 'paid';
  return 'voided';
}

// Build a balanced journal entry from pure ledger lines: drop zero-amount
// lines (e.g. tax=0), resolve codes → coa ids, push entry + line rows. Skips
// entries that collapse below the 2-line minimum (never happens for the
// invoice/expense shapes, but cheap to guard).
function pushEntry(
  entries: (typeof journalEntries.$inferInsert)[],
  jlines: (typeof journalLines.$inferInsert)[],
  scope: { accountId: string; companyId: string },
  coaId: Map<string, string>,
  spec: { sourceEntityId: string; memo: string; postedAt: Date; lines: LedgerLine[] },
): void {
  const live = spec.lines.filter((l) => Number(l.amount) > 0);
  if (live.length < 2) return;
  const entryId = uuidv7();
  entries.push({
    id: entryId,
    accountId: scope.accountId,
    companyId: scope.companyId,
    sourceEntityType: spec.memo.startsWith('expense') ? 'expense' : 'invoice',
    sourceEntityId: spec.sourceEntityId,
    postedAt: spec.postedAt,
    memo: spec.memo,
    createdAt: spec.postedAt,
  });
  for (const l of live) {
    jlines.push({
      id: uuidv7(),
      accountId: scope.accountId,
      journalEntryId: entryId,
      coaAccountId: coaId.get(l.code) as string,
      side: l.side,
      amount: l.amount,
      createdAt: spec.postedAt,
    });
  }
}

// Run `fn` over `total` items in batches of `size`, awaiting each.
async function batched(
  total: number,
  size: number,
  fn: (count: number, base: number) => Promise<void>,
) {
  for (let base = 0; base < total; base += size) {
    await fn(Math.min(size, total - base), base);
  }
}

// Highest trailing integer among existing INV-/EST- numbers on the company, so
// re-running the seeder appends instead of colliding on the unique index.
async function maxNumberSeq(
  db: Database,
  kind: 'invoice' | 'estimate',
  companyId: string,
): Promise<number> {
  const table = kind === 'invoice' ? invoices : estimates;
  const rows = await db
    .select({ number: table.number })
    .from(table)
    .where(eq(table.companyId, companyId));
  let max = 0;
  for (const r of rows) {
    const m = /(\d+)\s*$/.exec(r.number);
    if (m) max = Math.max(max, Number.parseInt(m[1] as string, 10));
  }
  return max;
}

async function resolveCompany(
  db: Database,
): Promise<{ id: string; accountId: string; name: string }> {
  if (cfg.company) {
    const [c] = await db
      .select({ id: companies.id, accountId: companies.accountId, name: companies.name })
      .from(companies)
      .where(eq(companies.id, cfg.company))
      .limit(1);
    if (!c) throw new Error(`no company with id ${cfg.company}`);
    return c;
  }
  if (cfg.email) {
    const [u] = await db
      .select({ id: authUser.id })
      .from(authUser)
      .where(eq(authUser.email, cfg.email.toLowerCase()))
      .limit(1);
    if (!u) throw new Error(`no user with email ${cfg.email}`);
    const [m] = await db
      .select({ accountId: memberships.accountId })
      .from(memberships)
      .where(eq(memberships.userId, u.id))
      .limit(1);
    if (!m) throw new Error(`user ${cfg.email} has no membership`);
    const [c] = await db
      .select({ id: companies.id, accountId: companies.accountId, name: companies.name })
      .from(companies)
      .where(eq(companies.accountId, m.accountId))
      .orderBy(asc(companies.createdAt))
      .limit(1);
    if (!c) throw new Error(`account ${m.accountId} has no company`);
    return c;
  }
  const [c] = await db
    .select({ id: companies.id, accountId: companies.accountId, name: companies.name })
    .from(companies)
    .orderBy(asc(companies.createdAt))
    .limit(1);
  if (!c) throw new Error('no companies in the DB — sign up first');
  console.log('⚠ no --email/--company given; using the first company in the DB.');
  return c;
}

async function resolveActor(db: Database, accountId: string): Promise<string> {
  const [m] = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(eq(memberships.accountId, accountId))
    .limit(1);
  return m?.userId ?? SYSTEM_USER_ID;
}

function redactUrl(u: string): string {
  try {
    const url = new URL(u);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '(unparseable)';
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

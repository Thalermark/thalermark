import { chartOfAccounts, companies } from '@thalermark/db';
import {
  type MoneyAccountKind,
  moneyAccountCreateSchema,
  moneyAccountUpdateSchema,
} from '@thalermark/validation';
import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { v7 as uuidv7 } from 'uuid';
import { UUID_RE } from '../lib/route-helpers.js';
import { requireCapability } from '../middleware/authz.js';
import type { RlsVariables } from '../middleware/rls-context.js';

// Money accounts (TMC-207) — the places a business's money sits.
//
// These ARE chart_of_accounts rows; this is the first and only endpoint that
// creates one. The chart was seed-only before, which is why every company had
// exactly one place money could go (Cash 1000) and the balance sheet's cash
// line could never be reconciled against a real bank statement.
//
// The user never learns they are editing a chart of accounts. They add "Chase
// Business Checking", pick what kind of thing it is, and the system decides
// asset vs liability, allocates the code, and keeps the double entry to itself.

// Where user-created accounts live, per kind.
//
// Codes are allocated inside reserved bands rather than sequentially from the
// end of the chart, for two reasons. The ledger posts by LITERAL code, so a code
// must be stable forever once anything points at it — bands make collisions with
// a future seed account impossible. And 1001–1099 sorts directly beneath Cash
// (1000) on the balance sheet, which is where a reader expects the other bank
// accounts to be.
//
// Verified free against all four entity charts: the base uses 1000/1200/1500/
// 1900 and 2000/2200/2700, and no overlay lands inside either band.
const BANDS: Record<MoneyAccountKind, { min: number; max: number }> = {
  checking: { min: 1001, max: 1099 },
  savings: { min: 1001, max: 1099 },
  cash: { min: 1001, max: 1099 },
  // A card is a liability: the balance is what you owe the issuer, and it grows
  // when you spend. Same band logic, the 2000s.
  credit_card: { min: 2100, max: 2199 },
};

function shapeFor(kind: MoneyAccountKind): {
  accountType: 'asset' | 'liability';
  normalBalance: 'debit' | 'credit';
} {
  // Exhaustive on purpose, where this used to be `credit_card ? … : asset`.
  // That ternary meant every kind EXCEPT a card fell through to asset/debit, so
  // adding a liability-shaped kind — a line of credit, say — would have filed it
  // as an asset without anyone editing this function. Money owed would have
  // counted as money held, and the balance sheet would have stopped adding up
  // from the first charge, silently.
  //
  // A switch with no default makes the compiler refuse a new kind until someone
  // says which shape it is. The `never` below is what enforces that: add a kind
  // to the enum and this stops building.
  switch (kind) {
    case 'checking':
    case 'savings':
    case 'cash':
      return { accountType: 'asset', normalBalance: 'debit' };
    case 'credit_card':
      return { accountType: 'liability', normalBalance: 'credit' };
    default: {
      const unhandled: never = kind;
      throw new Error(`money account kind has no chart-of-accounts shape: ${String(unhandled)}`);
    }
  }
}

// Lowest free code in the kind's band. Scans the company's existing codes rather
// than counting rows, so an archived account never has its code recycled — the
// ledger entries pointing at it stay meaningful, and un-archiving cannot collide.
async function nextCode(
  tx: RlsVariables['tx'],
  args: { accountId: string; companyId: string; kind: MoneyAccountKind },
): Promise<string | null> {
  const band = BANDS[args.kind];
  const rows = await tx
    .select({ code: chartOfAccounts.code })
    .from(chartOfAccounts)
    .where(
      and(
        eq(chartOfAccounts.accountId, args.accountId),
        eq(chartOfAccounts.companyId, args.companyId),
      ),
    );
  const taken = new Set(rows.map((r) => Number(r.code)));
  for (let code = band.min; code <= band.max; code += 1) {
    if (!taken.has(code)) return String(code);
  }
  return null;
}

// Archive / restore, via the is_active column the chart already had.
//
// Never a delete: the FK from every journal line is RESTRICT, and an account
// that held money is part of the books forever. Archiving takes it out of the
// pickers and nothing else — crucially NOT out of the balance sheet, because an
// archived account can still hold a balance and hiding that would make the
// books stop adding up.
async function setActive(c: Context<{ Variables: RlsVariables }>, id: string, isActive: boolean) {
  if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
  const tx = c.get('tx');
  const accountId = c.get('accountId');

  const [current] = await tx
    .select()
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.id, id), eq(chartOfAccounts.accountId, accountId)))
    .limit(1);
  if (!current) return c.json({ error: 'money_account_not_found' }, 404);
  // Only money accounts are manageable here. An ordinary ledger account (an
  // expense category, AR) must not be archivable through a screen that presents
  // itself as "your bank accounts".
  if (!current.moneyAccountKind) return c.json({ error: 'not_a_money_account' }, 400);

  // The seeded primary is the fallback every un-set money column resolves to.
  // Archiving it would leave rows pointing at an account the pickers refuse to
  // offer, and new postings with nowhere to default.
  if (!isActive && current.code === '1000') {
    return c.json({ error: 'cannot_archive_primary_account' }, 409);
  }

  if (current.isActive === isActive) return c.json(current);

  const now = new Date();
  const [updated] = await tx
    .update(chartOfAccounts)
    .set({ isActive, updatedAt: now })
    .where(and(eq(chartOfAccounts.id, id), eq(chartOfAccounts.accountId, accountId)))
    .returning();
  if (!updated) return c.json({ error: 'money_account_not_found' }, 404);

  await c.var.audit({
    entityType: 'money_account',
    entityId: id,
    action: isActive ? 'restore' : 'archive',
    before: { isActive: current.isActive },
    after: { isActive: updated.isActive },
    companyId: updated.companyId,
  });

  return c.json(updated);
}

export function moneyAccountsRoutes() {
  return (
    new Hono<{ Variables: RlsVariables }>()
      // The list every picker reads. Active-only by default, which is what makes
      // archiving take effect everywhere at once without a caller changing;
      // the settings screen passes includeArchived=true for its toggle.
      //
      // Returns the live balance alongside each account, because "which account
      // did I pay from" is a question people answer by looking at what is in
      // them. Signed debits − credits, matching cashOnHand: positive means money
      // held for a bank account, and for a card it means money owed.
      .get('/api/money-accounts', async (c) => {
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const companyId = c.req.query('companyId');
        if (!companyId || !UUID_RE.test(companyId)) {
          return c.json({ error: 'invalid_company_id' }, 400);
        }
        const includeArchived = c.req.query('includeArchived') === 'true';

        const conditions = [
          eq(chartOfAccounts.accountId, accountId),
          eq(chartOfAccounts.companyId, companyId),
          isNotNull(chartOfAccounts.moneyAccountKind),
        ];
        if (!includeArchived) conditions.push(eq(chartOfAccounts.isActive, true));

        const rows = await tx
          .select({
            id: chartOfAccounts.id,
            code: chartOfAccounts.code,
            name: chartOfAccounts.name,
            kind: chartOfAccounts.moneyAccountKind,
            accountType: chartOfAccounts.accountType,
            isActive: chartOfAccounts.isActive,
            balance: sql<string>`coalesce((
              select sum(case when jl.side = 'debit' then jl.amount else -jl.amount end)
              from journal_lines jl
              where jl.coa_account_id = ${chartOfAccounts.id}
            ), 0)::numeric(15,2)`,
          })
          .from(chartOfAccounts)
          .where(and(...conditions))
          .orderBy(asc(chartOfAccounts.code));

        return c.json({ moneyAccounts: rows });
      })
      .post(
        '/api/money-accounts',
        requireCapability('settings:manage'),
        validator('json', (value, c) => {
          const parsed = moneyAccountCreateSchema.safeParse(value);
          if (!parsed.success) {
            return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
          }
          return parsed.data;
        }),
        async (c) => {
          const data = c.req.valid('json');
          const tx = c.get('tx');
          const accountId = c.get('accountId');

          const [company] = await tx
            .select({ id: companies.id })
            .from(companies)
            .where(and(eq(companies.id, data.companyId), eq(companies.accountId, accountId)))
            .limit(1);
          if (!company) return c.json({ error: 'company_not_found' }, 404);

          const code = await nextCode(tx, {
            accountId,
            companyId: data.companyId,
            kind: data.kind,
          });
          // 99 accounts of one shape is far past any real business, but a full
          // band must fail loudly rather than silently reuse a code the ledger
          // already points at.
          if (!code) return c.json({ error: 'account_codes_exhausted' }, 409);

          const shape = shapeFor(data.kind);
          const id = uuidv7();
          const [created] = await tx
            .insert(chartOfAccounts)
            .values({
              id,
              accountId,
              companyId: data.companyId,
              code,
              name: data.name,
              accountType: shape.accountType,
              normalBalance: shape.normalBalance,
              moneyAccountKind: data.kind,
              // No tax line: a bank account is a balance-sheet item and appears
              // on no Schedule C line.
              taxMapping: null,
            })
            .returning();

          await c.var.audit({
            entityType: 'money_account',
            entityId: id,
            action: 'create',
            after: { code, name: data.name, kind: data.kind },
            companyId: data.companyId,
          });

          return c.json(created, 201);
        },
      )
      // Rename only. Kind is immutable — see moneyAccountUpdateSchema for why
      // flipping asset↔liability under existing postings is not offered.
      .patch(
        '/api/money-accounts/:id',
        requireCapability('settings:manage'),
        validator('json', (value, c) => {
          const parsed = moneyAccountUpdateSchema.safeParse(value);
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
            .from(chartOfAccounts)
            .where(and(eq(chartOfAccounts.id, id), eq(chartOfAccounts.accountId, accountId)))
            .limit(1);
          if (!before) return c.json({ error: 'money_account_not_found' }, 404);
          if (!before.moneyAccountKind) return c.json({ error: 'not_a_money_account' }, 400);

          const [after] = await tx
            .update(chartOfAccounts)
            .set({ name: data.name, updatedAt: new Date() })
            .where(and(eq(chartOfAccounts.id, id), eq(chartOfAccounts.accountId, accountId)))
            .returning();
          if (!after) return c.json({ error: 'money_account_not_found' }, 404);

          await c.var.audit({
            entityType: 'money_account',
            entityId: id,
            action: 'update',
            before: { name: before.name },
            after: { name: after.name },
            companyId: after.companyId,
          });

          return c.json(after);
        },
      )
      .post('/api/money-accounts/:id/archive', requireCapability('settings:manage'), (c) =>
        setActive(c, c.req.param('id'), false),
      )
      .post('/api/money-accounts/:id/restore', requireCapability('settings:manage'), (c) =>
        setActive(c, c.req.param('id'), true),
      )
  );
}

export type MoneyAccountsAppType = ReturnType<typeof moneyAccountsRoutes>;

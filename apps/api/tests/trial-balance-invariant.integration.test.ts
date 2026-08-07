import {
  authUser,
  chartOfAccounts,
  companies,
  journalEntries,
  journalLines,
  memberships,
} from '@thalermark/db';
import { and, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// The trial-balance invariant (TMC-188).
//
// The deferred trigger on journal_lines proves every INDIVIDUAL entry sums to
// zero. It says nothing about whether the RIGHT entries were posted, and
// nothing about what a long sequence of real operations leaves behind. That is
// the class of bug this file exists to catch: a posting SHAPE that balances on
// its own while quietly putting the company's books somewhere wrong.
//
// The approach is a randomised sequence driven through the real HTTP API — not
// the posting helpers — so it exercises the routes, the tenant transaction, the
// locks and the reporting layer exactly as a user would.
//
// WHAT COUNTS AS EVIDENCE HERE — read this before adding an assertion.
//
// The first version of this file asserted only "the trial balance nets to zero"
// and "the balance sheet reports itself balanced", and BOTH ARE VERY NEARLY
// TAUTOLOGIES. The deferred trigger already forces every entry to sum to zero,
// so the company-wide sum is zero by construction, and A = L + E is a
// re-grouping of that same zero. This was verified, not assumed: crediting
// invoice payments to Sales Tax Payable instead of Accounts Receivable — a
// completely wrong posting — left both assertions green.
//
// The assertions that actually bite are the CROSS-CHECKS further down: the same
// figure derived a second, independent way from the operational tables
// (invoices, invoice_payments, invoice_line_items) and compared against what
// the ledger believes. A posting on the wrong account fails those immediately,
// because the operational side has no idea the ledger made a mistake.
//
// This is not hypothetical. The cross-check found a real bug in shipped code on
// its first run: voiding a part-paid invoice credited AR for the full total on
// top of the payment's own credit. See the void guard in routes/invoices.ts.
//
// DETERMINISTIC RANDOMNESS. The seed is printed on failure and can be pinned
// with TRIAL_BALANCE_SEED=<n>. An invariant test whose failures cannot be
// replayed is worse than no test: it gets marked flaky and then ignored.

const testEnv: Env = {
  nodeEnv: 'test',
  port: 3000,
  logLevel: 'info',
  errorTrackingDsn: undefined,
  release: undefined,
  databaseUrl: '',
  appDatabaseUrl: '',
  appRolePassword: undefined,
  migrateOnBoot: false,
  betterAuthSecret: 'test-secret-at-least-32-characters-long',
  betterAuthUrl: 'http://localhost:3000',
  trustedOrigins: [],
  publicAppUrl: 'http://localhost:5173',
  resendApiKey: undefined,
  emailFrom: 'Thalermark <test@thalermark.test>',
  stripeSecretKey: undefined,
  stripePublishableKey: undefined,
  stripeWebhookSecret: undefined,
  recurringSweepCron: '0 6 * * *',
};

// mulberry32 — small, fast, and fully determined by its seed. Enough for
// "pick an operation and an amount"; nothing here is cryptographic.
function makeRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function extractSessionCookie(res: Response): string {
  const list =
    (res.headers as { getSetCookie?: () => string[] }).getSetCookie?.() ??
    [res.headers.get('set-cookie') ?? ''].filter(Boolean);
  return list.map((c) => c.split(';')[0]).join('; ');
}

function buildApp() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const handle = createApiDatabase(appDatabaseUrl());
  const auth = createApiAuth(getTestDb(), { ...testEnv, databaseUrl: url });
  const app = createApp({
    auth,
    db: handle.db,
    bootstrapDb: getTestDb(),
    publicAppUrl: testEnv.publicAppUrl,
  });
  return { app, handle };
}

async function setup(email: string) {
  const { app, handle } = buildApp();
  const signRes = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct horse battery staple', name: email }),
  });
  if (signRes.status !== 200) throw new Error(`sign-up failed: ${signRes.status}`);
  const cookie = extractSessionCookie(signRes);

  const db = getTestDb();
  const [user] = await db
    .select({ id: authUser.id })
    .from(authUser)
    .where(eq(authUser.email, email));
  if (!user) throw new Error('user not seeded');
  const [m] = await db
    .select({ accountId: memberships.accountId })
    .from(memberships)
    .where(eq(memberships.userId, user.id));
  if (!m) throw new Error('membership not seeded');
  const [company] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.accountId, m.accountId));
  if (!company) throw new Error('company not seeded');

  return {
    app,
    handle,
    accountId: m.accountId,
    companyId: company.id,
    headers: { cookie, 'x-account-id': m.accountId, 'content-type': 'application/json' },
  };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

// Debits positive, credits negative, across every line in the company. Correct
// books net to exactly zero — always, whatever ran.
async function trialBalanceCents(companyId: string): Promise<number> {
  const db = getTestDb();
  const [row] = await db
    .select({
      net: sql<string>`coalesce(sum(case when ${journalLines.side} = 'debit' then ${journalLines.amount} else -${journalLines.amount} end), 0)::numeric(15,2)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
    .where(eq(journalEntries.companyId, companyId));
  return Math.round(Number(row?.net ?? '0') * 100);
}

async function coaId(companyId: string, code: string): Promise<string> {
  const db = getTestDb();
  const [row] = await db
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.companyId, companyId), eq(chartOfAccounts.code, code)));
  if (!row) throw new Error(`COA ${code} missing`);
  return row.id;
}

// --- the operation pool ----------------------------------------------------
// Each returns a short label for the failure trace, or null when it could not
// run (nothing to pay, nothing to void). A null is not a failure — the sequence
// is random, so some operations legitimately have no valid target.

type Op = {
  label: string;
  run: (ctx: Ctx, rng: () => number, state: State) => Promise<string | null>;
};

type State = { invoices: string[]; expenses: string[]; purchases: string[]; payments: string[] };

const money = (rng: () => number, min: number, max: number): string =>
  (Math.floor(rng() * (max - min) + min) / 100).toFixed(2);

const dayIn2026 = (rng: () => number): string => {
  const month = String(Math.floor(rng() * 6) + 1).padStart(2, '0');
  const day = String(Math.floor(rng() * 28) + 1).padStart(2, '0');
  return `2026-${month}-${day}`;
};

async function makeContact(ctx: Ctx, rng: () => number): Promise<string> {
  const res = await ctx.app.request('/api/contacts', {
    method: 'POST',
    headers: ctx.headers,
    body: JSON.stringify({ companyId: ctx.companyId, name: `C${Math.floor(rng() * 1e6)}` }),
  });
  return ((await res.json()) as { id: string }).id;
}

const OPS: Op[] = [
  {
    label: 'invoice:create+send',
    run: async (ctx, rng, state) => {
      const contactId = await makeContact(ctx, rng);
      const subtotal = money(rng, 5_000, 200_000);
      const res = await ctx.app.request('/api/invoices', {
        method: 'POST',
        headers: ctx.headers,
        body: JSON.stringify({
          companyId: ctx.companyId,
          contactId,
          number: `INV-${Math.floor(rng() * 1e9)}`,
          issueDate: dayIn2026(rng),
          dueDate: '2026-12-01',
          subtotal,
          total: subtotal,
          lineItems: [
            {
              position: 1,
              description: 'Work',
              quantity: '1',
              unitPrice: subtotal,
              amount: subtotal,
              // Randomly product vs service so the revenue split (4000 vs 4100)
              // is exercised, not just one leg.
              type: rng() < 0.5 ? 'service' : 'product',
            },
          ],
        }),
      });
      if (res.status !== 201) return null;
      const id = ((await res.json()) as { id: string }).id;
      await ctx.app.request(`/api/invoices/${id}/mark-sent`, {
        method: 'POST',
        headers: ctx.headers,
      });
      state.invoices.push(id);
      return `invoice ${id} @ ${subtotal}`;
    },
  },
  {
    label: 'invoice:payment',
    run: async (ctx, rng, state) => {
      const id = state.invoices[Math.floor(rng() * state.invoices.length)];
      if (!id) return null;
      const res = await ctx.app.request(`/api/invoices/${id}/payments`, {
        method: 'POST',
        headers: ctx.headers,
        body: JSON.stringify({
          amount: money(rng, 1_000, 120_000),
          receivedOn: dayIn2026(rng),
          method: 'cash',
        }),
      });
      if (res.status !== 201) return null;
      const body = (await res.json()) as { payment: { id: string } };
      state.payments.push(`${id}:${body.payment.id}`);
      return `payment on ${id}`;
    },
  },
  {
    label: 'invoice:refund',
    run: async (ctx, rng, state) => {
      const id = state.invoices[Math.floor(rng() * state.invoices.length)];
      if (!id) return null;
      const res = await ctx.app.request(`/api/invoices/${id}/payments`, {
        method: 'POST',
        headers: ctx.headers,
        body: JSON.stringify({
          amount: `-${money(rng, 500, 40_000)}`,
          receivedOn: dayIn2026(rng),
          method: 'other',
        }),
      });
      return res.status === 201 ? `refund on ${id}` : null;
    },
  },
  {
    label: 'invoice:remove-payment',
    run: async (ctx, rng, state) => {
      const entry = state.payments[Math.floor(rng() * state.payments.length)];
      if (!entry) return null;
      const [invoiceId, paymentId] = entry.split(':');
      const res = await ctx.app.request(`/api/invoices/${invoiceId}/payments/${paymentId}`, {
        method: 'DELETE',
        headers: ctx.headers,
      });
      if (res.status !== 200) return null;
      state.payments = state.payments.filter((p) => p !== entry);
      return `removed payment ${paymentId}`;
    },
  },
  {
    label: 'invoice:void',
    run: async (ctx, rng, state) => {
      const id = state.invoices[Math.floor(rng() * state.invoices.length)];
      if (!id) return null;
      const res = await ctx.app.request(`/api/invoices/${id}/void`, {
        method: 'POST',
        headers: ctx.headers,
      });
      if (res.status !== 200) return null;
      state.invoices = state.invoices.filter((i) => i !== id);
      return `voided ${id}`;
    },
  },
  {
    label: 'expense:create',
    run: async (ctx, rng, state) => {
      const res = await ctx.app.request('/api/expenses', {
        method: 'POST',
        headers: ctx.headers,
        body: JSON.stringify({
          companyId: ctx.companyId,
          categoryAccountId: await coaId(ctx.companyId, '7000'),
          paymentAccountId: await coaId(ctx.companyId, '1000'),
          amount: money(rng, 500, 50_000),
          expenseDate: dayIn2026(rng),
          merchant: 'Supplier',
        }),
      });
      if (res.status !== 201) return null;
      const id = ((await res.json()) as { id: string }).id;
      state.expenses.push(id);
      return `expense ${id}`;
    },
  },
  {
    label: 'expense:delete',
    run: async (ctx, rng, state) => {
      const id = state.expenses[Math.floor(rng() * state.expenses.length)];
      if (!id) return null;
      const res = await ctx.app.request(`/api/expenses/${id}`, {
        method: 'DELETE',
        headers: ctx.headers,
      });
      if (!res.ok) return null;
      state.expenses = state.expenses.filter((e) => e !== id);
      return `deleted expense ${id}`;
    },
  },
  {
    label: 'owner-money',
    run: async (ctx, rng) => {
      const kind = rng() < 0.5 ? 'contribution' : 'draw';
      const res = await ctx.app.request('/api/owner-money', {
        method: 'POST',
        headers: ctx.headers,
        body: JSON.stringify({
          companyId: ctx.companyId,
          kind,
          amount: money(rng, 1_000, 80_000),
          occurredOn: dayIn2026(rng),
        }),
      });
      return res.status === 201 ? `owner ${kind}` : null;
    },
  },
  {
    label: 'purchase:capital',
    run: async (ctx, rng, state) => {
      const amount = money(rng, 20_000, 400_000);
      // Mix §179 write-off with capitalise-and-spread, and mix financed with
      // paid-in-full, so all four posting shapes appear.
      const financed = rng() < 0.5;
      const res = await ctx.app.request('/api/purchases', {
        method: 'POST',
        headers: ctx.headers,
        body: JSON.stringify({
          companyId: ctx.companyId,
          description: 'Mower',
          amount,
          purchaseDate: dayIn2026(rng),
          paidNow: financed ? money(rng, 1_000, 15_000) : amount,
          taxTreatment: rng() < 0.5 ? 'deduct_now' : 'spread',
        }),
      });
      if (res.status !== 201) return null;
      const id = ((await res.json()) as { id: string }).id;
      state.purchases.push(id);
      return `purchase ${id}`;
    },
  },
  {
    label: 'purchase:delete',
    run: async (ctx, rng, state) => {
      const id = state.purchases[Math.floor(rng() * state.purchases.length)];
      if (!id) return null;
      const res = await ctx.app.request(`/api/purchases/${id}`, {
        method: 'DELETE',
        headers: ctx.headers,
      });
      if (!res.ok) return null;
      state.purchases = state.purchases.filter((p) => p !== id);
      return `deleted purchase ${id}`;
    },
  },
  {
    label: 'bill:create',
    run: async (ctx, rng) => {
      const res = await ctx.app.request('/api/bills', {
        method: 'POST',
        headers: ctx.headers,
        body: JSON.stringify({
          companyId: ctx.companyId,
          contactId: await makeContact(ctx, rng),
          categoryAccountId: await coaId(ctx.companyId, '7000'),
          amount: money(rng, 1_000, 60_000),
          billDate: dayIn2026(rng),
          dueDate: '2026-12-15',
        }),
      });
      return res.status === 201 ? 'bill' : null;
    },
  },
  {
    label: 'ledger:manual-entry',
    run: async (ctx, rng) => {
      // A balanced hand-posted pair, the accountant's surface. Exercises the
      // account-id-keyed path rather than the code-keyed helpers.
      const amount = money(rng, 500, 30_000);
      const res = await ctx.app.request('/api/ledger/entries', {
        method: 'POST',
        headers: ctx.headers,
        body: JSON.stringify({
          companyId: ctx.companyId,
          postedOn: dayIn2026(rng),
          memo: 'Adjustment',
          lines: [
            { coaAccountId: await coaId(ctx.companyId, '7000'), side: 'debit', amount },
            { coaAccountId: await coaId(ctx.companyId, '1000'), side: 'credit', amount },
          ],
        }),
      });
      return res.status === 201 ? 'manual entry' : null;
    },
  },
];

// --- the checks that actually leave the system -----------------------------
//
// A NOTE ON WHAT IS AND ISN'T EVIDENCE HERE, because it is easy to get wrong
// and this file got it wrong first:
//
// "The trial balance nets to zero" and "the balance sheet balances" are both
// very nearly TAUTOLOGIES. The deferred trigger already forces every entry to
// sum to zero, so the company-wide sum is zero by construction, and A = L + E
// is just a re-grouping of that same zero. Both were verified to be worthless
// on their own: crediting invoice payments to Sales Tax Payable instead of
// Accounts Receivable — a completely wrong posting — left both assertions
// green.
//
// They are kept, because a drift would still be alarming and cheap to detect.
// But the checks below are the ones with teeth: they derive the SAME figure a
// second, independent way, from the operational tables, and compare. A posting
// that lands on the wrong account fails these immediately, because the
// operational side has no idea the ledger made a mistake.

// AR the ledger believes in.
async function ledgerArCents(companyId: string): Promise<number> {
  const db = getTestDb();
  const [row] = await db
    .select({
      net: sql<string>`coalesce(sum(case when ${journalLines.side} = 'debit' then ${journalLines.amount} else -${journalLines.amount} end), 0)::numeric(15,2)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
    .innerJoin(chartOfAccounts, eq(journalLines.coaAccountId, chartOfAccounts.id))
    .where(and(eq(journalEntries.companyId, companyId), eq(chartOfAccounts.code, '1200')));
  return Math.round(Number(row?.net ?? '0') * 100);
}

// AR the OPERATIONAL tables imply: for every issued, non-voided invoice, what
// is still owed on it. Computed from `invoices` and `invoice_payments` with no
// reference to the ledger whatsoever — that independence is the whole point.
async function operationalArCents(companyId: string): Promise<number> {
  const db = getTestDb();
  const [row] = await db
    .execute<{ owed: string }>(sql`
    SELECT coalesce(sum(i.total - coalesce(p.paid, 0)), 0)::numeric(15,2) AS owed
    FROM invoices i
    LEFT JOIN (
      SELECT invoice_id, sum(amount) AS paid
      FROM invoice_payments GROUP BY invoice_id
    ) p ON p.invoice_id = i.id
    WHERE i.company_id = ${companyId} AND i.status IN ('sent', 'paid')
  `)
    .then((r) => r.rows);
  return Math.round(Number(row?.owed ?? '0') * 100);
}

// Recognised revenue, likewise derived twice — and checked PER ACCOUNT rather
// than as one total.
//
// Summing 4000 + 4100 together was the first attempt and it was too weak:
// routing the entire subtotal to Service Revenue left the combined figure
// correct, so the check passed against a deliberately broken split. The split
// is not cosmetic — Service and Product land on different lines of the federal
// return — so each leg is compared to its own operational source.
async function ledgerRevenueCents(companyId: string, code: string): Promise<number> {
  const db = getTestDb();
  const [row] = await db
    .select({
      net: sql<string>`coalesce(sum(case when ${journalLines.side} = 'credit' then ${journalLines.amount} else -${journalLines.amount} end), 0)::numeric(15,2)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
    .innerJoin(chartOfAccounts, eq(journalLines.coaAccountId, chartOfAccounts.id))
    .where(and(eq(journalEntries.companyId, companyId), eq(chartOfAccounts.code, code)));
  return Math.round(Number(row?.net ?? '0') * 100);
}

// From the LINE ITEMS, which carry the type snapshot the posting split off.
async function operationalRevenueCents(
  companyId: string,
  lineType: 'service' | 'product',
): Promise<number> {
  const db = getTestDb();
  const [row] = await db
    .execute<{ rev: string }>(sql`
    SELECT coalesce(sum(li.amount), 0)::numeric(15,2) AS rev
    FROM invoice_line_items li
    JOIN invoices i ON i.id = li.invoice_id
    WHERE i.company_id = ${companyId}
      AND i.status IN ('sent', 'paid')
      AND li.type = ${lineType}
  `)
    .then((r) => r.rows);
  return Math.round(Number(row?.rev ?? '0') * 100);
}

// The balance-sheet REPORT's own verdict. Weak on its own (see the note above),
// but it exercises the reporting path and would catch an account that belongs
// to no type group at all.
async function balanceSheetBalanced(ctx: Ctx): Promise<{ balanced: boolean; detail: string }> {
  const res = await ctx.app.request(
    `/api/companies/${ctx.companyId}/balance-sheet?asOf=2026-12-31`,
    { headers: ctx.headers },
  );
  if (!res.ok) return { balanced: false, detail: `balance-sheet ${res.status}` };
  const body = (await res.json()) as {
    balanced: boolean;
    totalAssets: string;
    totalLiabilitiesAndEquity: string;
  };
  return {
    balanced: body.balanced,
    detail: `assets ${body.totalAssets} vs L+E ${body.totalLiabilitiesAndEquity}`,
  };
}

describe('trial-balance invariant across randomised operation sequences', () => {
  beforeEach(resetDb);

  it('holds after every mutation in a long random sequence', async () => {
    const seed = Number(process.env.TRIAL_BALANCE_SEED ?? 20260806);
    const rng = makeRng(seed);
    const ctx = await setup('invariant@test.com');
    const state: State = { invoices: [], expenses: [], purchases: [], payments: [] };
    const trace: string[] = [];

    try {
      for (let i = 0; i < 120; i++) {
        const op = OPS[Math.floor(rng() * OPS.length)];
        if (!op) continue;
        const detail = await op.run(ctx, rng, state);
        if (!detail) continue;
        trace.push(`${i}: ${op.label} — ${detail}`);

        const replay = `seed=${seed} — replay with TRIAL_BALANCE_SEED=${seed}\ntrace:\n${trace.slice(-12).join('\n')}`;

        const net = await trialBalanceCents(ctx.companyId);
        if (net !== 0) {
          throw new Error(
            `trial balance drifted to ${net} cents after step ${i} (${op.label}).\n${replay}`,
          );
        }

        // The checks with teeth. Same figure, derived independently from the
        // operational tables — a posting on the wrong account fails here.
        const [ledgerAr, opAr] = await Promise.all([
          ledgerArCents(ctx.companyId),
          operationalArCents(ctx.companyId),
        ]);
        if (ledgerAr !== opAr) {
          throw new Error(
            `AR disagrees after step ${i} (${op.label}): ledger says ${ledgerAr}, invoices say ${opAr}.\n${replay}`,
          );
        }

        for (const [code, lineType] of [
          ['4000', 'service'],
          ['4100', 'product'],
        ] as const) {
          const [ledgerRev, opRev] = await Promise.all([
            ledgerRevenueCents(ctx.companyId, code),
            operationalRevenueCents(ctx.companyId, lineType),
          ]);
          if (ledgerRev !== opRev) {
            throw new Error(
              `${lineType} revenue (${code}) disagrees after step ${i} (${op.label}): ledger says ${ledgerRev}, line items say ${opRev}.\n${replay}`,
            );
          }
        }
      }

      // At least a few operations must have actually landed, or a sequence that
      // silently no-opped everything would pass a zero trial balance trivially.
      expect(trace.length).toBeGreaterThan(30);

      const sheet = await balanceSheetBalanced(ctx);
      if (!sheet.balanced) {
        throw new Error(
          `balance sheet does not balance: ${sheet.detail}\n` +
            `seed=${seed} — replay with TRIAL_BALANCE_SEED=${seed}`,
        );
      }

      // And the ledger is genuinely populated — this is a real book, not an
      // empty one that balances by having nothing in it.
      const db = getTestDb();
      const [{ count } = { count: 0 }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(journalLines)
        .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
        .where(eq(journalEntries.companyId, ctx.companyId));
      expect(Number(count)).toBeGreaterThan(100);
    } finally {
      await ctx.handle.close();
    }
  });

  // A second, independent sequence. Different seed, different interleaving —
  // the invariant is a property, not a fixture, so it should hold under any
  // ordering rather than only the one that happened to be written down.
  it('holds under a different interleaving', async () => {
    const seed = Number(process.env.TRIAL_BALANCE_SEED ?? 987654321);
    const rng = makeRng(seed);
    const ctx = await setup('invariant2@test.com');
    const state: State = { invoices: [], expenses: [], purchases: [], payments: [] };

    try {
      for (let i = 0; i < 80; i++) {
        const op = OPS[Math.floor(rng() * OPS.length)];
        if (!op) continue;
        await op.run(ctx, rng, state);
        const net = await trialBalanceCents(ctx.companyId);
        if (net !== 0) {
          throw new Error(
            `trial balance drifted to ${net} cents at step ${i} (${op.label}); seed=${seed}`,
          );
        }
        const [ledgerAr, opAr] = await Promise.all([
          ledgerArCents(ctx.companyId),
          operationalArCents(ctx.companyId),
        ]);
        if (ledgerAr !== opAr) {
          throw new Error(
            `AR disagrees at step ${i} (${op.label}): ledger ${ledgerAr} vs invoices ${opAr}; seed=${seed}`,
          );
        }
      }
      const sheet = await balanceSheetBalanced(ctx);
      expect(sheet.balanced, sheet.detail).toBe(true);
    } finally {
      await ctx.handle.close();
    }
  });
});

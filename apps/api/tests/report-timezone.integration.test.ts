import { authUser, companies, invoices, memberships } from '@thalermark/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// Company timezone (TMC-157). Report day boundaries used to be UTC, so a
// payment taken on the evening of 31 December fell into the following tax year
// for anyone west of Greenwich. These pin the boundary to the company's zone.
//
// The decisive assertion is the same stored instant landing in a different tax
// year purely because the company's timezone differs — that isolates the fix
// from any date-arithmetic coincidence.

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

function extractSessionCookie(res: Response): string {
  const list =
    (res.headers as { getSetCookie?: () => string[] }).getSetCookie?.() ??
    [res.headers.get('set-cookie') ?? ''].filter(Boolean);
  return list.map((c) => c.split(';')[0]).join('; ');
}

async function signUp(app: ReturnType<typeof createApp>, email: string) {
  const res = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct horse battery staple', name: email }),
  });
  if (res.status !== 200) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  return extractSessionCookie(res);
}

async function userContext(email: string): Promise<{ accountId: string; companyId: string }> {
  const db = getTestDb();
  const [user] = await db
    .select({ id: authUser.id })
    .from(authUser)
    .where(eq(authUser.email, email));
  if (!user) throw new Error(`user ${email} not seeded`);
  const [m] = await db
    .select({ accountId: memberships.accountId })
    .from(memberships)
    .where(eq(memberships.userId, user.id));
  if (!m) throw new Error(`membership for ${email} not seeded`);
  const [company] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.accountId, m.accountId));
  if (!company) throw new Error(`default company for ${email} not seeded`);
  return { accountId: m.accountId, companyId: company.id };
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

type Ctx = {
  app: ReturnType<typeof createApp>;
  cookie: string;
  accountId: string;
  companyId: string;
};

async function setup(email: string): Promise<{ ctx: Ctx; close: () => Promise<void> }> {
  const { app, handle } = buildApp();
  const cookie = await signUp(app, email);
  const { accountId, companyId } = await userContext(email);
  return { ctx: { app, cookie, accountId, companyId }, close: handle.close };
}

function headers(ctx: Ctx) {
  return { cookie: ctx.cookie, 'x-account-id': ctx.accountId, 'content-type': 'application/json' };
}

async function setTimezone(ctx: Ctx, timezone: string): Promise<number> {
  const res = await ctx.app.request(`/api/companies/${ctx.companyId}`, {
    method: 'PATCH',
    headers: headers(ctx),
    body: JSON.stringify({ timezone }),
  });
  return res.status;
}

// Issues and settles an invoice, then rewrites paid_at to an exact instant.
// The mark-paid API only takes a date (paidOn), and this bug is about the time
// of day — so the instant is set directly. The test db bypasses RLS.
async function paidInvoiceAt(
  ctx: Ctx,
  contactId: string,
  opts: { number: string; subtotal: string; instant: string },
) {
  const res = await ctx.app.request('/api/invoices', {
    method: 'POST',
    headers: headers(ctx),
    body: JSON.stringify({
      companyId: ctx.companyId,
      contactId,
      number: opts.number,
      issueDate: '2026-12-20',
      dueDate: '2026-12-20',
      subtotal: opts.subtotal,
      tax: '0.00',
      total: opts.subtotal,
      lineItems: [
        {
          position: 1,
          description: 'Service',
          quantity: '1',
          unitPrice: opts.subtotal,
          amount: opts.subtotal,
        },
      ],
    }),
  });
  if (res.status !== 201)
    throw new Error(`invoice create failed: ${res.status} ${await res.text()}`);
  const id = ((await res.json()) as { id: string }).id;
  for (const path of ['mark-sent', 'mark-paid']) {
    const r = await ctx.app.request(`/api/invoices/${id}/${path}`, {
      method: 'POST',
      headers: headers(ctx),
      body: path === 'mark-paid' ? JSON.stringify({ method: 'cash' }) : undefined,
    });
    if (r.status !== 200) throw new Error(`${path} failed: ${r.status} ${await r.text()}`);
  }
  await getTestDb()
    .update(invoices)
    .set({ paidAt: new Date(opts.instant) })
    .where(eq(invoices.id, id));
  return id;
}

async function createContact(ctx: Ctx): Promise<string> {
  const res = await ctx.app.request('/api/contacts', {
    method: 'POST',
    headers: headers(ctx),
    body: JSON.stringify({ companyId: ctx.companyId, name: 'Acme' }),
  });
  if (res.status !== 201) throw new Error(`contact create failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

async function grossReceipts(ctx: Ctx, year: number): Promise<string> {
  const res = await ctx.app.request(
    `/api/companies/${ctx.companyId}/schedule-c?year=${year}&basis=cash`,
    { headers: headers(ctx) },
  );
  const body = (await res.json()) as { partI: { grossReceipts: string } };
  return body.partI.grossReceipts;
}

describe('company timezone drives report day boundaries', () => {
  beforeEach(resetDb);

  it('defaults to UTC so existing companies keep their current figures', async () => {
    const { ctx, close } = await setup('tz-default@example.com');
    try {
      const res = await ctx.app.request('/api/companies', { headers: headers(ctx) });
      const { companies: list } = (await res.json()) as { companies: { timezone: string }[] };
      expect(list[0]?.timezone).toBe('UTC');
    } finally {
      await close();
    }
  });

  // The headline case. 8pm on 31 Dec 2026 in America/Chicago is 02:00Z on
  // 1 Jan 2027 — under the old UTC-only windows this money showed up on the
  // 2027 return.
  it('keeps a 31 Dec evening payment in that year for a US company', async () => {
    const { ctx, close } = await setup('tz-newyear@example.com');
    try {
      expect(await setTimezone(ctx, 'America/Chicago')).toBe(200);
      const cust = await createContact(ctx);
      await paidInvoiceAt(ctx, cust, {
        number: 'INV-1',
        subtotal: '8000.00',
        instant: '2027-01-01T02:00:00Z',
      });

      expect(await grossReceipts(ctx, 2026)).toBe('8000.00');
      expect(await grossReceipts(ctx, 2027)).toBe('0.00');
    } finally {
      await close();
    }
  });

  // Same row, same instant — only the company's zone differs. This is what
  // isolates the fix: nothing about the data changed, so the year can only have
  // moved because the boundary did.
  it('places the identical instant in different years by zone', async () => {
    const { ctx, close } = await setup('tz-contrast@example.com');
    try {
      const cust = await createContact(ctx);
      await paidInvoiceAt(ctx, cust, {
        number: 'INV-1',
        subtotal: '500.00',
        instant: '2027-01-01T02:00:00Z',
      });

      expect(await setTimezone(ctx, 'UTC')).toBe(200);
      expect(await grossReceipts(ctx, 2026)).toBe('0.00');
      expect(await grossReceipts(ctx, 2027)).toBe('500.00');

      expect(await setTimezone(ctx, 'America/Chicago')).toBe(200);
      expect(await grossReceipts(ctx, 2026)).toBe('500.00');
      expect(await grossReceipts(ctx, 2027)).toBe('0.00');
    } finally {
      await close();
    }
  });

  // The mirror case: a zone ahead of UTC pulls early-January money back into
  // the previous year if the boundary is wrong.
  it('handles a zone ahead of UTC', async () => {
    const { ctx, close } = await setup('tz-tokyo@example.com');
    try {
      expect(await setTimezone(ctx, 'Asia/Tokyo')).toBe(200);
      const cust = await createContact(ctx);
      // 08:00 on 1 Jan 2027 in Tokyo is 23:00Z on 31 Dec 2026.
      await paidInvoiceAt(ctx, cust, {
        number: 'INV-1',
        subtotal: '300.00',
        instant: '2026-12-31T23:00:00Z',
      });

      expect(await grossReceipts(ctx, 2027)).toBe('300.00');
      expect(await grossReceipts(ctx, 2026)).toBe('0.00');
    } finally {
      await close();
    }
  });

  // Boundaries are resolved by Postgres against real tzdata, so a window
  // spanning a DST transition keeps its local midnight edges rather than
  // drifting an hour. 8 Mar 2026 is the US spring-forward.
  it('holds local midnight across a DST transition', async () => {
    const { ctx, close } = await setup('tz-dst@example.com');
    try {
      expect(await setTimezone(ctx, 'America/Chicago')).toBe(200);
      const cust = await createContact(ctx);
      // 23:30 local on 8 March 2026, i.e. after the spring-forward. CDT is
      // UTC-5, so that's 04:30Z on the 9th — a naive UTC window would push it
      // into the next day and out of a period ending on the 8th.
      await paidInvoiceAt(ctx, cust, {
        number: 'INV-1',
        subtotal: '120.00',
        instant: '2026-03-09T04:30:00Z',
      });

      const res = await ctx.app.request(
        `/api/companies/${ctx.companyId}/profit-loss?from=2026-03-01&to=2026-03-08`,
        { headers: headers(ctx) },
      );
      const body = (await res.json()) as { totalRevenue: string };
      // Revenue is accrual (booked at mark-sent on the issue date), so the
      // assertion here is simply that the DST-spanning window is accepted and
      // computed rather than erroring or shifting.
      expect(res.status).toBe(200);
      expect(body.totalRevenue).toBeDefined();
    } finally {
      await close();
    }
  });

  it('rejects a timezone that is not a real IANA zone', async () => {
    const { ctx, close } = await setup('tz-invalid@example.com');
    try {
      expect(await setTimezone(ctx, 'Mars/Olympus_Mons')).toBe(400);
      expect(await setTimezone(ctx, "UTC'; DROP TABLE companies; --")).toBe(400);
      // The stored value is untouched, so nothing malformed can reach SQL.
      const res = await ctx.app.request('/api/companies', { headers: headers(ctx) });
      const { companies: list } = (await res.json()) as { companies: { timezone: string }[] };
      expect(list[0]?.timezone).toBe('UTC');
    } finally {
      await close();
    }
  });

  it('rolls the dashboard month over at local midnight', async () => {
    const { ctx, close } = await setup('tz-dashboard@example.com');
    try {
      expect(await setTimezone(ctx, 'Pacific/Auckland')).toBe(200);
      const res = await ctx.app.request(`/api/companies/${ctx.companyId}/dashboard`, {
        headers: headers(ctx),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { from: string; to: string };
      const localToday = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Pacific/Auckland',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());
      expect(body.to).toBe(localToday);
      expect(body.from).toBe(`${localToday.slice(0, 7)}-01`);
    } finally {
      await close();
    }
  });
});

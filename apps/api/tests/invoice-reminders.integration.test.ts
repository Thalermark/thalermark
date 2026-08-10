import {
  authUser,
  companies,
  contacts,
  invoicePayments,
  invoiceReminders,
  invoices,
  memberships,
} from '@thalermark/db';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { createConsoleMailer } from '../src/lib/mailer.js';
import { sweepInvoiceReminders } from '../src/lib/reminders.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// Automated payment reminders (TMC-189).
//
// This sweep is the only one that mails a THIRD PARTY — the customer of the
// person using the software, in that person's name. A bug here is not a wrong
// number on a screen, it is an email that cannot be recalled. So the tests are
// weighted towards the cases where it must STAY SILENT, not the happy path.
//
// Rows are seeded directly rather than driven through the API: every assertion
// here turns on an exact calendar date, and going through the invoice endpoints
// would put the dates at one remove from the thing under test.

const testEnv: Env = {
  nodeEnv: 'test',
  port: 3000,
  logLevel: 'error',
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
} as unknown as Env;

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

type Ctx = Awaited<ReturnType<typeof setup>>;

async function setup(email: string) {
  const { app, handle } = buildApp();
  const res = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct horse battery staple', name: email }),
  });
  if (res.status !== 200) throw new Error(`sign-up failed: ${res.status}`);
  const list =
    (res.headers as { getSetCookie?: () => string[] }).getSetCookie?.() ??
    [res.headers.get('set-cookie') ?? ''].filter(Boolean);
  const cookie = list.map((c) => c.split(';')[0]).join('; ');

  const db = getTestDb();
  const [user] = await db.select().from(authUser).where(eq(authUser.email, email));
  if (!user) throw new Error('user not seeded');
  const [m] = await db.select().from(memberships).where(eq(memberships.userId, user.id));
  if (!m) throw new Error('membership not seeded');
  const [company] = await db.select().from(companies).where(eq(companies.accountId, m.accountId));
  if (!company) throw new Error('company not seeded');

  // Reminders are OFF by default — every test that expects a send has to turn
  // them on, which is itself the assertion that the default is silent.
  const contactId = uuidv7();
  await db.insert(contacts).values({
    id: contactId,
    accountId: m.accountId,
    companyId: company.id,
    name: 'Customer',
    email: 'customer@example.com',
  });

  return {
    app,
    handle,
    accountId: m.accountId,
    companyId: company.id,
    contactId,
    db,
    // For the few assertions that go through the HTTP surface rather than
    // seeding rows — the opt-out route below.
    authHeaders: { cookie, 'x-account-id': m.accountId } as Record<string, string>,
  };
}

async function enableReminders(ctx: Ctx, offsets: number[], timezone = 'UTC') {
  await ctx.db
    .update(companies)
    .set({ remindersEnabled: true, reminderOffsets: offsets, timezone })
    .where(eq(companies.id, ctx.companyId));
}

// An ISSUED invoice with a known due date. status 'sent' is what the sweep
// targets: issued, and not settled.
async function seedInvoice(
  ctx: Ctx,
  opts: { dueDate: string; total?: string; status?: string; optedOut?: boolean },
): Promise<string> {
  const id = uuidv7();
  await ctx.db.insert(invoices).values({
    id,
    accountId: ctx.accountId,
    companyId: ctx.companyId,
    contactId: ctx.contactId,
    // The TAIL of a uuidv7, not the head: the leading hex is a timestamp, so
    // invoices seeded in the same millisecond collide on (company, number).
    number: `INV-${id.slice(-12)}`,
    issueDate: '2026-06-01',
    dueDate: opts.dueDate,
    subtotal: opts.total ?? '1000.00',
    tax: '0.00',
    total: opts.total ?? '1000.00',
    status: opts.status ?? 'sent',
    sentAt: new Date('2026-06-01T00:00:00Z'),
    remindersOptedOut: opts.optedOut ?? false,
  });
  return id;
}

async function seedPayment(ctx: Ctx, invoiceId: string, amount: string, receivedOn: string) {
  await ctx.db.insert(invoicePayments).values({
    id: uuidv7(),
    accountId: ctx.accountId,
    companyId: ctx.companyId,
    invoiceId,
    amount,
    receivedOn,
    method: 'cash',
  });
}

type SentMail = { to: string; subject: string; text?: string; html?: string };

// Captures what would have gone out. A reminder that "sent" without a mailer
// would still bank its row and burn the stage, so the no-mailer path is a
// throw, not a silent success — see the dedicated test below.
function stubMailer(sink: SentMail[]) {
  return {
    async send(msg: { to: string; subject: string; text?: string; html?: string }) {
      sink.push(msg);
    },
  };
}

function sweep(ctx: Ctx, now: string, sink: SentMail[] = []) {
  return sweepInvoiceReminders({
    bootstrapDb: getTestDb(),
    tenantDb: ctx.handle.db,
    mail: { mailer: stubMailer(sink), emailFrom: 'billing@example.com' },
    now: new Date(now),
  });
}

async function remindersFor(ctx: Ctx, invoiceId: string) {
  return ctx.db.select().from(invoiceReminders).where(eq(invoiceReminders.invoiceId, invoiceId));
}

describe('sweepInvoiceReminders', () => {
  beforeEach(resetDb);

  it('fires on the exact day, and not one day later', async () => {
    // THE guard. Written as `due_date + offset <= today` — the natural way —
    // switching this feature on would fire every stage of every overdue invoice
    // at once, in one burst, to real customers.
    const ctx = await setup('exact-day@test.com');
    try {
      await enableReminders(ctx, [7]);
      const id = await seedInvoice(ctx, { dueDate: '2026-06-10' });

      // The day before the stage: silent.
      expect((await sweep(ctx, '2026-06-16T09:00:00Z')).sent).toBe(0);
      // The day itself: one reminder.
      expect((await sweep(ctx, '2026-06-17T09:00:00Z')).sent).toBe(1);
      expect(await remindersFor(ctx, id)).toHaveLength(1);
      // The day after: silent again. NOTE this particular assertion does NOT
      // catch a `<=` regression — the already-sent guard masks it once the
      // stage has fired. Verified by injecting `<=`: only the short-dated test
      // below goes red. The damage `<=` does is the BURST on first enable, not
      // a repeat of a stage that already went out.
      expect((await sweep(ctx, '2026-06-18T09:00:00Z')).sent).toBe(0);
      expect(await remindersFor(ctx, id)).toHaveLength(1);
    } finally {
      await ctx.handle.close();
    }
  });

  it('never fires a stage whose day passed before the invoice existed', async () => {
    // The short-dated invoice: issued Friday, due in three days, with a "5 days
    // before" stage whose date is already in the past. It must simply not have
    // that day rather than firing late.
    const ctx = await setup('short-dated@test.com');
    try {
      await enableReminders(ctx, [-5]);
      await seedInvoice(ctx, { dueDate: '2026-06-03' }); // -5 lands on 05-29
      expect((await sweep(ctx, '2026-06-02T09:00:00Z')).sent).toBe(0);
      expect((await sweep(ctx, '2026-06-03T09:00:00Z')).sent).toBe(0);
    } finally {
      await ctx.handle.close();
    }
  });

  it('sends exactly once per stage, however often the sweep runs', async () => {
    const ctx = await setup('once-only@test.com');
    try {
      await enableReminders(ctx, [0]);
      const id = await seedInvoice(ctx, { dueDate: '2026-06-10' });
      await sweep(ctx, '2026-06-10T06:00:00Z');
      await sweep(ctx, '2026-06-10T12:00:00Z');
      await sweep(ctx, '2026-06-10T23:00:00Z');
      expect(await remindersFor(ctx, id)).toHaveLength(1);
    } finally {
      await ctx.handle.close();
    }
  });

  it('stays quiet for a few days after money arrives', async () => {
    // The landscaper scenario: deposit taken Friday, job starts Saturday, and
    // the "coming due" reminder would otherwise land the next morning on a
    // customer who paid yesterday.
    const ctx = await setup('quiet-after-payment@test.com');
    try {
      await enableReminders(ctx, [-5]);
      const id = await seedInvoice(ctx, { dueDate: '2026-06-10' }); // fires 06-05
      await seedPayment(ctx, id, '400.00', '2026-06-04'); // yesterday
      expect((await sweep(ctx, '2026-06-05T09:00:00Z')).sent).toBe(0);
      expect(await remindersFor(ctx, id)).toHaveLength(0);
    } finally {
      await ctx.handle.close();
    }
  });

  it('a post-dated cheque does not silence every future reminder', async () => {
    // The bug found while verifying the guard above. `received_on > today - 3`
    // is open-ended, so a FUTURE-dated receipt matches it and suppresses every
    // remaining stage on that invoice forever — silently. The window has to be
    // bounded at both ends.
    const ctx = await setup('post-dated@test.com');
    try {
      await enableReminders(ctx, [-5]);
      const id = await seedInvoice(ctx, { dueDate: '2026-06-10' }); // fires 06-05
      await seedPayment(ctx, id, '100.00', '2026-09-01'); // months away
      expect((await sweep(ctx, '2026-06-05T09:00:00Z')).sent).toBe(1);
    } finally {
      await ctx.handle.close();
    }
  });

  it('chases the OUTSTANDING balance, not the invoice total', async () => {
    // Third instance of the "owed == total" bug class in this epic, and the
    // first that would reach a customer's inbox.
    const ctx = await setup('outstanding@test.com');
    try {
      await enableReminders(ctx, [7]);
      const id = await seedInvoice(ctx, { dueDate: '2026-06-10', total: '1000.00' });
      await seedPayment(ctx, id, '400.00', '2026-06-01'); // old enough to be quiet-safe
      await sweep(ctx, '2026-06-17T09:00:00Z');
      const [row] = await remindersFor(ctx, id);
      expect(row?.outstanding).toBe('600.00');
    } finally {
      await ctx.handle.close();
    }
  });

  it('the email quotes what is owed, and never the invoice total', async () => {
    // The assertion this whole feature turns on. A $1,000 invoice with $400
    // paid must chase $600 — anything else emails a wrong number to someone
    // who is not our user, in our user's name.
    const ctx = await setup('email-body@test.com');
    try {
      await enableReminders(ctx, [7]);
      const id = await seedInvoice(ctx, { dueDate: '2026-06-10', total: '1000.00' });
      await seedPayment(ctx, id, '400.00', '2026-06-01');
      const sink: SentMail[] = [];
      await sweep(ctx, '2026-06-17T09:00:00Z', sink);

      expect(sink).toHaveLength(1);
      expect(sink[0]?.to).toBe('customer@example.com');
      const body = `${sink[0]?.subject} ${sink[0]?.text}`;
      expect(body).toContain('600.00');
      expect(body).not.toContain('1000.00');
    } finally {
      await ctx.handle.close();
    }
  });

  it('does not bank the stage when there is no mailer to send with', async () => {
    // A self-host without SMTP. Recording the row anyway would burn the stage
    // forever — switching mail on later would find every reminder already
    // "sent" and the customer would never hear anything.
    //
    // Counted as SKIPPED, not failed (TMC-212). Nothing went wrong: the sweep
    // looked at a server that cannot send and left the work for later. It used
    // to reach the per-item guard and throw, which rolled the row back — right
    // outcome, wrong signal, and it logged an error per due invoice on every
    // single sweep of an install that was merely unconfigured.
    const ctx = await setup('no-mailer@test.com');
    try {
      await enableReminders(ctx, [7]);
      const id = await seedInvoice(ctx, { dueDate: '2026-06-10' });
      const result = await sweepInvoiceReminders({
        bootstrapDb: getTestDb(),
        tenantDb: ctx.handle.db,
        mail: {},
        now: new Date('2026-06-17T09:00:00Z'),
      });
      expect(result.sent).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(1);
      // The whole point: nothing banked, so the stage is still owed.
      expect(await remindersFor(ctx, id)).toHaveLength(0);
    } finally {
      await ctx.handle.close();
    }
  });

  it('holds reminders when the mailer only logs, rather than burning the stage', async () => {
    // The case that actually shipped (TMC-212). The guard above tested for a
    // MISSING mailer, but bootstrap always wires the console driver, so it
    // never fired on a real deploy: every sweep on a self-host without email
    // banked a full set of rows for messages written to stdout, and configuring
    // email later found every stage already "sent".
    const ctx = await setup('console-mailer@test.com');
    try {
      await enableReminders(ctx, [7]);
      const id = await seedInvoice(ctx, { dueDate: '2026-06-10' });
      const result = await sweepInvoiceReminders({
        bootstrapDb: getTestDb(),
        tenantDb: ctx.handle.db,
        mail: {
          mailer: createConsoleMailer({ from: 'Thalermark <hello@thalermark.test>' }),
          emailFrom: 'Thalermark <hello@thalermark.test>',
        },
        now: new Date('2026-06-17T09:00:00Z'),
      });
      expect(result.sent).toBe(0);
      expect(result.skipped).toBe(1);
      expect(await remindersFor(ctx, id)).toHaveLength(0);
    } finally {
      await ctx.handle.close();
    }
  });

  it('never emails a customer who has no address on file', async () => {
    const ctx = await setup('no-email@test.com');
    try {
      await enableReminders(ctx, [7]);
      await ctx.db.update(contacts).set({ email: null }).where(eq(contacts.id, ctx.contactId));
      const id = await seedInvoice(ctx, { dueDate: '2026-06-10' });
      const sink: SentMail[] = [];
      expect((await sweep(ctx, '2026-06-17T09:00:00Z', sink)).sent).toBe(0);
      expect(sink).toHaveLength(0);
      expect(await remindersFor(ctx, id)).toHaveLength(0);
    } finally {
      await ctx.handle.close();
    }
  });

  it('says nothing at all when the company has not switched it on', async () => {
    const ctx = await setup('default-off@test.com');
    try {
      // Deliberately NOT calling enableReminders — the shipped default.
      await seedInvoice(ctx, { dueDate: '2026-06-10' });
      expect((await sweep(ctx, '2026-06-17T09:00:00Z')).sent).toBe(0);
    } finally {
      await ctx.handle.close();
    }
  });

  it('respects a per-invoice opt-out', async () => {
    const ctx = await setup('opted-out@test.com');
    try {
      await enableReminders(ctx, [7]);
      const id = await seedInvoice(ctx, { dueDate: '2026-06-10', optedOut: true });
      expect((await sweep(ctx, '2026-06-17T09:00:00Z')).sent).toBe(0);
      expect(await remindersFor(ctx, id)).toHaveLength(0);
    } finally {
      await ctx.handle.close();
    }
  });

  it('a sent invoice can be opted out through the API, and then is left alone', async () => {
    // The escape hatch: "I have spoken to them, do not chase this one." The
    // route is separate from the invoice PATCH on purpose — that PATCH is
    // draft-only and would reject every invoice this matters for.
    const ctx = await setup('opt-out-route@test.com');
    try {
      await enableReminders(ctx, [7]);
      const id = await seedInvoice(ctx, { dueDate: '2026-06-10' });

      const res = await ctx.app.request(`/api/invoices/${id}/reminders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...ctx.authHeaders },
        body: JSON.stringify({ optedOut: true }),
      });
      expect(res.status).toBe(200);

      expect((await sweep(ctx, '2026-06-17T09:00:00Z')).sent).toBe(0);
      expect(await remindersFor(ctx, id)).toHaveLength(0);
    } finally {
      await ctx.handle.close();
    }
  });

  it('never chases a settled or voided invoice', async () => {
    const ctx = await setup('settled@test.com');
    try {
      await enableReminders(ctx, [7]);
      await seedInvoice(ctx, { dueDate: '2026-06-10', status: 'paid' });
      await seedInvoice(ctx, { dueDate: '2026-06-10', status: 'voided' });
      await seedInvoice(ctx, { dueDate: '2026-06-10', status: 'draft' });
      expect((await sweep(ctx, '2026-06-17T09:00:00Z')).sent).toBe(0);
    } finally {
      await ctx.handle.close();
    }
  });

  it('never chases under a retired business name', async () => {
    const ctx = await setup('retired@test.com');
    try {
      await enableReminders(ctx, [7]);
      await seedInvoice(ctx, { dueDate: '2026-06-10' });
      await ctx.db
        .update(companies)
        .set({ retiredAt: new Date('2026-06-01T00:00:00Z') })
        .where(eq(companies.id, ctx.companyId));
      expect((await sweep(ctx, '2026-06-17T09:00:00Z')).sent).toBe(0);
    } finally {
      await ctx.handle.close();
    }
  });

  it('fires on the calendar day the operator is living in, not UTC', async () => {
    // A company in Auckland (UTC+12) is already on the 17th while UTC is still
    // on the 16th. The reminder belongs to their day, not Greenwich's.
    const ctx = await setup('timezone@test.com');
    try {
      await enableReminders(ctx, [7], 'Pacific/Auckland');
      const id = await seedInvoice(ctx, { dueDate: '2026-06-10' }); // stage = 06-17
      // 16 June 23:00 UTC is already 17 June in Auckland.
      expect((await sweep(ctx, '2026-06-16T23:00:00Z')).sent).toBe(1);
      const [row] = await remindersFor(ctx, id);
      expect(row?.sentOn).toBe('2026-06-17');
    } finally {
      await ctx.handle.close();
    }
  });
});

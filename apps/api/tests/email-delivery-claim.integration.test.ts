import {
  auditEvents,
  authUser,
  companies,
  contacts,
  invoiceReminders,
  invoices,
  memberships,
} from '@thalermark/db';
import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { type ApiDatabase, createApiDatabase } from '../src/lib/db.js';
import { type Mailer, createConsoleMailer } from '../src/lib/mailer.js';
import { sweepInvoiceReminders } from '../src/lib/reminders.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// TMC-212 — the app must stop claiming a delivery that did not happen.
//
// The console mailer logs the message and resolves, which is indistinguishable
// from a real send to every caller. So a self-host with no SMTP saw "Sent to
// bob@example.com", banked an audit row saying the invoice was emailed, and
// burned every reminder stage — for mail that went to stdout. Refusing to boot
// without a mailer was rejected (a self-host must come up with email
// unconfigured), so instead the fake driver declares itself and the callers
// stop vouching for it.
//
// EVERY TEST HERE BUILDS THE APP WITH THE REAL `createConsoleMailer`, not a
// hand-rolled stand-in. The claim under test is a property of the driver that
// actually ships; a recorder with `logsOnly: true` bolted on would only prove
// the test file can set a flag. Each case is paired with a delivering recorder
// so a hardcoded `false` cannot pass.

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
  resendApiKey: undefined,
  emailFrom: 'Thalermark <test@thalermark.test>',
  stripeSecretKey: undefined,
  stripePublishableKey: undefined,
  stripeWebhookSecret: undefined,
  recurringSweepCron: '0 6 * * *',
};

const EMAIL_FROM = 'Thalermark <test@thalermark.test>';

// The shipped fallback driver, exactly as server.ts wires it when
// RESEND_API_KEY is unset.
function consoleMailer(): Mailer {
  return createConsoleMailer({ from: EMAIL_FROM });
}

type SentMail = {
  to: string;
  subject: string;
  html: string;
  text: string;
  from?: string;
  replyTo?: string;
};

// A mailer that carries no `logsOnly` marker — i.e. what every real transport
// (and every other recorder in this suite) looks like. This is the control side
// of each assertion below.
function makeRecorder() {
  const sent: SentMail[] = [];
  return {
    sent,
    mailer: {
      async send(msg: SentMail) {
        sent.push(msg);
      },
    } satisfies Mailer,
  };
}

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

function buildApp(opts: { mailer?: Mailer } = {}) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const handle = createApiDatabase(appDatabaseUrl());
  const auth = createApiAuth(getTestDb(), { ...testEnv, databaseUrl: url });
  const app = createApp({
    auth,
    db: handle.db,
    bootstrapDb: getTestDb(),
    publicAppUrl: testEnv.publicAppUrl,
    mailer: opts.mailer,
    emailFrom: EMAIL_FROM,
  });
  return { app, handle };
}

type CtxApp = { app: ReturnType<typeof createApp>; handle: ApiDatabase };

// Swap the driver under a live account: close the current pool, rebuild the app
// with a different mailer, and keep the same cookie + rows. The whole point of
// these tests is that ONLY the mailer differs between the two answers.
function swapMailer(ctx: CtxApp, mailer: Mailer): Promise<void> {
  return ctx.handle.close().then(() => {
    const next = buildApp({ mailer });
    ctx.app = next.app;
    ctx.handle = next.handle;
  });
}

async function createContact(
  ctx: CtxApp,
  cookie: string,
  accountId: string,
  companyId: string,
  email = 'wile@acme.test',
): Promise<string> {
  const res = await ctx.app.request('/api/contacts', {
    method: 'POST',
    headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
    body: JSON.stringify({ companyId, name: 'Wile E. Coyote', email }),
  });
  if (res.status !== 201) throw new Error(`customer create failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

function invoiceBody(companyId: string, contactId: string, number = 'INV-001') {
  return {
    companyId,
    contactId,
    number,
    issueDate: '2026-05-23',
    dueDate: '2026-06-22',
    subtotal: '100.00',
    tax: '8.25',
    total: '108.25',
    lineItems: [
      { position: 1, description: 'Service', quantity: '1', unitPrice: '100.00', amount: '100.00' },
    ],
  };
}

async function seedDraftInvoice(
  ctx: CtxApp,
  signupEmail: string,
): Promise<{ cookie: string; accountId: string; companyId: string; invoiceId: string }> {
  const cookie = await signUp(ctx.app, signupEmail);
  const { accountId, companyId } = await userContext(signupEmail);
  const contactId = await createContact(ctx, cookie, accountId, companyId);
  const create = await ctx.app.request('/api/invoices', {
    method: 'POST',
    headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
    body: JSON.stringify(invoiceBody(companyId, contactId)),
  });
  if (create.status !== 201) throw new Error(`seed invoice failed: ${create.status}`);
  const { id } = (await create.json()) as { id: string };
  return { cookie, accountId, companyId, invoiceId: id };
}

type SendResponse = { sentTo: string; delivered: boolean; status: string };

describe('POST /api/invoices/:id/send — the delivery claim (TMC-212)', () => {
  beforeEach(resetDb);

  it('reports delivered: false when the mailer is the shipped console driver', async () => {
    const ctx = buildApp({ mailer: consoleMailer() });
    try {
      const { cookie, accountId, invoiceId } = await seedDraftInvoice(ctx, 'stdout@example.com');
      const res = await ctx.app.request(`/api/invoices/${invoiceId}/send`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as SendResponse;
      expect(body.delivered).toBe(false);
      // The two facts are separate and both are true: the invoice IS issued —
      // status flipped, ledger posted — and nothing reached the customer. The
      // payload has to carry both or the UI cannot tell them apart.
      expect(body.status).toBe('sent');
      expect(body.sentTo).toBe('wile@acme.test');
    } finally {
      await ctx.handle.close();
    }
  });

  // THE CONTROL. Without it the test above passes against a hardcoded `false`,
  // and "we never claim delivery" is not a fix, it is a different lie.
  it('reports delivered: true through a mailer that actually delivers', async () => {
    const rec = makeRecorder();
    const ctx = buildApp({ mailer: rec.mailer });
    try {
      const { cookie, accountId, invoiceId } = await seedDraftInvoice(ctx, 'realmail@example.com');
      const res = await ctx.app.request(`/api/invoices/${invoiceId}/send`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as SendResponse;
      expect(body.delivered).toBe(true);
      expect(rec.sent).toHaveLength(1);
      expect(rec.sent[0]?.to).toBe('wile@acme.test');

      // And the permanent record agrees with the banner on this side too.
      const [row] = await getTestDb()
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.entityId, invoiceId), eq(auditEvents.action, 'email-sent')));
      expect(row?.after).toMatchObject({ to: 'wile@acme.test', delivered: true });
    } finally {
      await ctx.handle.close();
    }
  });

  // The half that persists. A toast is forgettable; an audit row saying the
  // customer was emailed on the 3rd is what someone reads back in September
  // while trying to work out why they were never paid.
  it('writes delivered: false onto the audit row, which outlives the banner', async () => {
    const ctx = buildApp({ mailer: consoleMailer() });
    try {
      const { cookie, accountId, invoiceId } = await seedDraftInvoice(ctx, 'auditrow@example.com');
      const res = await ctx.app.request(`/api/invoices/${invoiceId}/send`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(200);

      const rows = await getTestDb()
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.entityId, invoiceId), eq(auditEvents.action, 'email-sent')));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.after).toMatchObject({ to: 'wile@acme.test', delivered: false });
    } finally {
      await ctx.handle.close();
    }
  });
});

describe('the other messages sent on a user behalf (TMC-212)', () => {
  beforeEach(resetDb);

  // A resend is idempotent, so the same estimate can answer the question twice
  // — once through the console driver, once through a real one. Same row, same
  // account, only the mailer changes.
  it('an estimate send says false on the console driver and true on a real one', async () => {
    const ctx = buildApp({ mailer: consoleMailer() });
    try {
      const cookie = await signUp(ctx.app, 'estimate-claim@example.com');
      const { accountId, companyId } = await userContext('estimate-claim@example.com');
      const contactId = await createContact(ctx, cookie, accountId, companyId);
      const headers = { cookie, 'x-account-id': accountId, 'content-type': 'application/json' };
      const create = await ctx.app.request('/api/estimates', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          companyId,
          contactId,
          number: 'EST-001',
          issueDate: '2026-05-23',
          expiresOn: '2026-06-22',
          subtotal: '100.00',
          tax: '8.25',
          total: '108.25',
          lineItems: [
            {
              position: 1,
              description: 'Quote — service',
              quantity: '1',
              unitPrice: '100.00',
              amount: '100.00',
            },
          ],
        }),
      });
      expect(create.status).toBe(201);
      const { id: estimateId } = (await create.json()) as { id: string };

      const logged = await ctx.app.request(`/api/estimates/${estimateId}/send`, {
        method: 'POST',
        headers,
        body: '{}',
      });
      expect(logged.status).toBe(200);
      const loggedBody = (await logged.json()) as SendResponse;
      expect(loggedBody.delivered).toBe(false);
      expect(loggedBody.status).toBe('sent');

      const rec = makeRecorder();
      await swapMailer(ctx, rec.mailer);
      const delivered = await ctx.app.request(`/api/estimates/${estimateId}/send`, {
        method: 'POST',
        headers,
        body: '{}',
      });
      expect(delivered.status).toBe(200);
      expect(((await delivered.json()) as SendResponse).delivered).toBe(true);
      expect(rec.sent).toHaveLength(1);
    } finally {
      await ctx.handle.close();
    }
  });

  it('a statement send says false on the console driver and true on a real one', async () => {
    const ctx = buildApp({ mailer: consoleMailer() });
    try {
      const cookie = await signUp(ctx.app, 'statement-claim@example.com');
      const { accountId, companyId } = await userContext('statement-claim@example.com');
      const contactId = await createContact(ctx, cookie, accountId, companyId);
      const headers = { cookie, 'x-account-id': accountId, 'content-type': 'application/json' };

      const logged = await ctx.app.request(`/api/contacts/${contactId}/statement/send`, {
        method: 'POST',
        headers,
        body: '{}',
      });
      expect(logged.status).toBe(200);
      expect((await logged.json()) as { sentTo: string; delivered: boolean }).toEqual({
        sentTo: 'wile@acme.test',
        delivered: false,
      });
      const [loggedAudit] = await getTestDb()
        .select()
        .from(auditEvents)
        .where(
          and(eq(auditEvents.entityId, contactId), eq(auditEvents.action, 'statement-emailed')),
        );
      expect(loggedAudit?.after).toMatchObject({ delivered: false });

      const rec = makeRecorder();
      await swapMailer(ctx, rec.mailer);
      const delivered = await ctx.app.request(`/api/contacts/${contactId}/statement/send`, {
        method: 'POST',
        headers,
        body: '{}',
      });
      expect(delivered.status).toBe(200);
      expect((await delivered.json()) as { sentTo: string; delivered: boolean }).toEqual({
        sentTo: 'wile@acme.test',
        delivered: true,
      });
      expect(rec.sent).toHaveLength(1);
    } finally {
      await ctx.handle.close();
    }
  });

  // The invite is the case where the honest answer is also the useful one: the
  // row committed and the token works, so a self-host operator can copy the
  // link out instead of waiting for an email that is never coming.
  it('an invitation is not claimed as emailed, and its token still works', async () => {
    const ctx = buildApp({ mailer: consoleMailer() });
    try {
      const inviterCookie = await signUp(ctx.app, 'inviter-claim@example.com');
      const { accountId } = await userContext('inviter-claim@example.com');
      // Existing user → the explicit accept path (a brand-new invitee is
      // auto-joined by the signup hook and never touches the token).
      const guestCookie = await signUp(ctx.app, 'guest-claim@example.com');

      const res = await ctx.app.request('/api/invitations', {
        method: 'POST',
        headers: {
          cookie: inviterCookie,
          'x-account-id': accountId,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ email: 'guest-claim@example.com' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { token: string; delivered: boolean; email: string };
      expect(body.delivered).toBe(false);
      expect(body.token).toMatch(/^[0-9a-f]{64}$/);

      const accept = await ctx.app.request(`/api/invitations/${body.token}/accept`, {
        method: 'POST',
        headers: { cookie: guestCookie },
      });
      expect(accept.status).toBe(200);
      expect((await accept.json()) as { accountId: string }).toMatchObject({ accountId });

      // Control: the same route through a delivering mailer says so.
      const rec = makeRecorder();
      await swapMailer(ctx, rec.mailer);
      const second = await ctx.app.request('/api/invitations', {
        method: 'POST',
        headers: {
          cookie: inviterCookie,
          'x-account-id': accountId,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ email: 'second-guest@example.com' }),
      });
      expect(second.status).toBe(201);
      expect(((await second.json()) as { delivered: boolean }).delivered).toBe(true);
      expect(rec.sent).toHaveLength(1);
    } finally {
      await ctx.handle.close();
    }
  });
});

describe('GET /api/companies/:id/email-templates (TMC-212)', () => {
  beforeEach(resetDb);

  // Settings → Email is where someone sits down to fine-tune the wording of
  // messages that, on an unconfigured install, are going to stdout. The screen
  // has to know.
  it('reports emailConfigured false on the console driver and true on a real one', async () => {
    const ctx = buildApp({ mailer: consoleMailer() });
    try {
      const cookie = await signUp(ctx.app, 'templates-claim@example.com');
      const { accountId, companyId } = await userContext('templates-claim@example.com');
      const headers = { cookie, 'x-account-id': accountId };

      const logged = await ctx.app.request(`/api/companies/${companyId}/email-templates`, {
        headers,
      });
      expect(logged.status).toBe(200);
      const loggedBody = (await logged.json()) as {
        emailConfigured: boolean;
        templates: unknown[];
      };
      expect(loggedBody.emailConfigured).toBe(false);
      // The templates themselves are still served — nothing is disabled, the
      // operator is just told the truth about where the mail goes.
      expect(loggedBody.templates.length).toBeGreaterThan(0);

      await swapMailer(ctx, makeRecorder().mailer);
      const delivering = await ctx.app.request(`/api/companies/${companyId}/email-templates`, {
        headers,
      });
      expect(delivering.status).toBe(200);
      expect(((await delivering.json()) as { emailConfigured: boolean }).emailConfigured).toBe(
        true,
      );
    } finally {
      await ctx.handle.close();
    }
  });
});

describe('sweepInvoiceReminders — the stage that must not be burned (TMC-212)', () => {
  beforeEach(resetDb);

  // THE ONE THAT COSTS MONEY. The per-item guard tested `!mailer`, and
  // bootstrap always wires the console driver, so it never fired: every sweep
  // on a self-host without email wrote a full set of invoice_reminders rows for
  // messages that went to stdout. Switching email on later found every stage
  // already "sent", and the customer was never chased — silently, forever.
  //
  // Seeded directly rather than driven through the endpoints for the same
  // reason invoice-reminders.integration.test.ts does: every assertion turns on
  // an exact calendar date.
  it('banks nothing while mail only reaches stdout, then banks it once email works', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'reminder-claim@example.com');
      const { accountId, companyId } = await userContext('reminder-claim@example.com');
      const contactId = await createContact(
        ctx,
        cookie,
        accountId,
        companyId,
        'customer@example.test',
      );

      const db = getTestDb();
      await db
        .update(companies)
        .set({ remindersEnabled: true, reminderOffsets: [7], timezone: 'UTC' })
        .where(eq(companies.id, companyId));

      const invoiceId = uuidv7();
      await db.insert(invoices).values({
        id: invoiceId,
        accountId,
        companyId,
        contactId,
        number: `INV-${invoiceId.slice(-12)}`,
        issueDate: '2026-06-01',
        dueDate: '2026-06-10',
        subtotal: '1000.00',
        tax: '0.00',
        total: '1000.00',
        status: 'sent',
        sentAt: new Date('2026-06-01T00:00:00Z'),
      });
      // due 06-10 + a 7-day stage = 06-17, the day the sweep below runs.
      const now = new Date('2026-06-17T09:00:00Z');
      const banked = () =>
        db.select().from(invoiceReminders).where(eq(invoiceReminders.invoiceId, invoiceId));

      const loggedOnly = await sweepInvoiceReminders({
        bootstrapDb: db,
        tenantDb: ctx.handle.db,
        mail: { mailer: consoleMailer(), emailFrom: EMAIL_FROM },
        now,
      });
      // Skipped, not failed: nothing went wrong, there is simply nowhere for
      // the mail to go, and the stage is left for a later sweep.
      expect(loggedOnly).toMatchObject({ sent: 0, skipped: 1, failed: 0, scanned: 1 });
      expect(await banked()).toHaveLength(0);

      // Now email is configured. The stage was still there to fire — which is
      // the whole point of not banking it — and this run chases the customer
      // for real. Proves the skip above is conditional on the driver, not a
      // blanket disable of the sweep.
      const rec = makeRecorder();
      const withEmail = await sweepInvoiceReminders({
        bootstrapDb: db,
        tenantDb: ctx.handle.db,
        mail: { mailer: rec.mailer, emailFrom: EMAIL_FROM },
        now,
      });
      expect(withEmail).toMatchObject({ sent: 1, skipped: 0, failed: 0, scanned: 1 });

      const rows = await banked();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.offsetDays).toBe(7);
      expect(rows[0]?.sentOn).toBe('2026-06-17');
      expect(rows[0]?.outstanding).toBe('1000.00');
      expect(rec.sent).toHaveLength(1);
      expect(rec.sent[0]?.to).toBe('customer@example.test');
    } finally {
      await ctx.handle.close();
    }
  });

  // Guard against the cheapest wrong fix: bailing whenever `contacts` are
  // involved, or on every sweep. A delivering mailer must reach the customer on
  // the first run, with no console driver anywhere in the story.
  it('a delivering mailer banks the stage on the first sweep', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'reminder-control@example.com');
      const { accountId, companyId } = await userContext('reminder-control@example.com');
      const contactId = await createContact(
        ctx,
        cookie,
        accountId,
        companyId,
        'control@example.test',
      );

      const db = getTestDb();
      await db
        .update(companies)
        .set({ remindersEnabled: true, reminderOffsets: [7], timezone: 'UTC' })
        .where(eq(companies.id, companyId));
      const invoiceId = uuidv7();
      await db.insert(invoices).values({
        id: invoiceId,
        accountId,
        companyId,
        contactId,
        number: `INV-${invoiceId.slice(-12)}`,
        issueDate: '2026-06-01',
        dueDate: '2026-06-10',
        subtotal: '250.00',
        tax: '0.00',
        total: '250.00',
        status: 'sent',
        sentAt: new Date('2026-06-01T00:00:00Z'),
      });

      const rec = makeRecorder();
      const result = await sweepInvoiceReminders({
        bootstrapDb: db,
        tenantDb: ctx.handle.db,
        mail: { mailer: rec.mailer, emailFrom: EMAIL_FROM },
        now: new Date('2026-06-17T09:00:00Z'),
      });
      expect(result).toMatchObject({ sent: 1, skipped: 0, failed: 0 });
      expect(
        await db.select().from(invoiceReminders).where(eq(invoiceReminders.invoiceId, invoiceId)),
      ).toHaveLength(1);
      expect(rec.sent).toHaveLength(1);
      expect(rec.sent[0]?.to).toBe('control@example.test');
      // Sanity on the fixture: the contact really does carry the address the
      // reminder used, so a green run is not an empty scan.
      const [row] = await db.select().from(contacts).where(eq(contacts.id, contactId));
      expect(row?.email).toBe('control@example.test');
    } finally {
      await ctx.handle.close();
    }
  });
});

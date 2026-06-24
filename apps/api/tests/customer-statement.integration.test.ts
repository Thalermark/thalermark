import { authUser, companies, memberships } from '@thalermark/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// Customer statement: a customer's issued invoices as a chronological
// charge/payment ledger with a running balance ending in the balance due.

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

type SentMail = {
  to: string;
  subject: string;
  html: string;
  text: string;
  from?: string;
  replyTo?: string;
};
function makeRecorder() {
  const sent: SentMail[] = [];
  return {
    sent,
    mailer: {
      async send(msg: SentMail) {
        sent.push(msg);
      },
    },
  };
}

function buildApp(opts: { mailer?: import('../src/lib/mailer.js').Mailer } = {}) {
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
    emailFrom: 'Thalermark <test@thalermark.test>',
  });
  return { app, handle };
}

type Ctx = {
  app: ReturnType<typeof createApp>;
  cookie: string;
  accountId: string;
  companyId: string;
};

async function setup(
  email: string,
  opts: { mailer?: import('../src/lib/mailer.js').Mailer } = {},
): Promise<{ ctx: Ctx; close: () => Promise<void> }> {
  const { app, handle } = buildApp(opts);
  const cookie = await signUp(app, email);
  const { accountId, companyId } = await userContext(email);
  return { ctx: { app, cookie, accountId, companyId }, close: handle.close };
}

function headers(ctx: Ctx) {
  return { cookie: ctx.cookie, 'x-account-id': ctx.accountId, 'content-type': 'application/json' };
}

async function createContact(
  ctx: Ctx,
  name = 'Acme',
  email: string | null = 'acme@example.com',
): Promise<string> {
  const res = await ctx.app.request('/api/contacts', {
    method: 'POST',
    headers: headers(ctx),
    body: JSON.stringify(
      email ? { companyId: ctx.companyId, name, email } : { companyId: ctx.companyId, name },
    ),
  });
  if (res.status !== 201) throw new Error(`customer create failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

async function createInvoice(
  ctx: Ctx,
  contactId: string,
  opts: { number: string; issueDate: string; total: string },
): Promise<string> {
  const res = await ctx.app.request('/api/invoices', {
    method: 'POST',
    headers: headers(ctx),
    body: JSON.stringify({
      companyId: ctx.companyId,
      contactId,
      number: opts.number,
      issueDate: opts.issueDate,
      dueDate: opts.issueDate,
      subtotal: opts.total,
      tax: '0.00',
      total: opts.total,
      lineItems: [
        {
          position: 1,
          description: 'Service',
          quantity: '1',
          unitPrice: opts.total,
          amount: opts.total,
        },
      ],
    }),
  });
  if (res.status !== 201)
    throw new Error(`invoice create failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

async function post(ctx: Ctx, path: string, body?: unknown): Promise<void> {
  const res = await ctx.app.request(path, {
    method: 'POST',
    headers: headers(ctx),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status !== 200) throw new Error(`POST ${path} failed: ${res.status} ${await res.text()}`);
}

type Statement = {
  statementDate: string;
  company: { name: string };
  customer: { id: string; name: string; email: string | null };
  lines: {
    date: string;
    description: string;
    charge: string | null;
    payment: string | null;
    balance: string;
  }[];
  totalCharges: string;
  totalPayments: string;
  balanceDue: string;
};

describe('GET /api/contacts/:id/statement', () => {
  beforeEach(resetDb);

  it('builds a charge/payment ledger ending in the balance due', async () => {
    const { ctx, close } = await setup('stmt@example.com');
    try {
      const cust = await createContact(ctx);
      // INV-2 issued earlier (01-05), sent + paid → charge then payment, net 0.
      const inv2 = await createInvoice(ctx, cust, {
        number: 'INV-2',
        issueDate: '2026-01-05',
        total: '50.00',
      });
      await post(ctx, `/api/invoices/${inv2}/mark-sent`);
      await post(ctx, `/api/invoices/${inv2}/mark-paid`, { method: 'cash' });
      // INV-1 issued 01-10, sent only → outstanding charge.
      const inv1 = await createInvoice(ctx, cust, {
        number: 'INV-1',
        issueDate: '2026-01-10',
        total: '100.00',
      });
      await post(ctx, `/api/invoices/${inv1}/mark-sent`);
      // A draft (never billed) and a voided invoice must not appear.
      await createInvoice(ctx, cust, {
        number: 'INV-DRAFT',
        issueDate: '2026-01-12',
        total: '30.00',
      });
      const voided = await createInvoice(ctx, cust, {
        number: 'INV-VOID',
        issueDate: '2026-01-13',
        total: '20.00',
      });
      await post(ctx, `/api/invoices/${voided}/mark-sent`);
      await post(ctx, `/api/invoices/${voided}/void`);

      const res = await ctx.app.request(`/api/contacts/${cust}/statement`, {
        headers: headers(ctx),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Statement;

      // Three ledger lines: INV-2 charge, INV-1 charge, INV-2 payment (paid today).
      expect(body.lines).toHaveLength(3);
      expect(body.lines[0]).toMatchObject({
        description: 'Invoice INV-2',
        charge: '50.00',
        payment: null,
        balance: '50.00',
      });
      expect(body.lines[1]).toMatchObject({
        description: 'Invoice INV-1',
        charge: '100.00',
        payment: null,
        balance: '150.00',
      });
      expect(body.lines[2]).toMatchObject({
        description: 'Payment received — INV-2',
        charge: null,
        payment: '50.00',
        balance: '100.00',
      });

      expect(body.totalCharges).toBe('150.00');
      expect(body.totalPayments).toBe('50.00');
      expect(body.balanceDue).toBe('100.00');
      expect(body.customer.name).toBe('Acme');
      expect(body.customer.email).toBe('acme@example.com');
    } finally {
      await close();
    }
  });

  it('returns an empty ledger + zero balance for a customer with no billed invoices', async () => {
    const { ctx, close } = await setup('stmt-empty@example.com');
    try {
      const cust = await createContact(ctx);
      const res = await ctx.app.request(`/api/contacts/${cust}/statement`, {
        headers: headers(ctx),
      });
      const body = (await res.json()) as Statement;
      expect(body.lines).toEqual([]);
      expect(body.balanceDue).toBe('0.00');
    } finally {
      await close();
    }
  });

  it('404s a customer in another account', async () => {
    const { ctx, close } = await setup('stmt-a@example.com');
    try {
      const cust = await createContact(ctx);
      const bCookie = await signUp(ctx.app, 'stmt-b@example.com');
      const b = await userContext('stmt-b@example.com');
      const res = await ctx.app.request(`/api/contacts/${cust}/statement`, {
        headers: { cookie: bCookie, 'x-account-id': b.accountId },
      });
      expect(res.status).toBe(404);
    } finally {
      await close();
    }
  });
});

describe('POST /api/contacts/:id/statement/send', () => {
  beforeEach(resetDb);

  it('emails the statement to the customer and records the send', async () => {
    const rec = makeRecorder();
    const { ctx, close } = await setup('send@example.com', { mailer: rec.mailer });
    try {
      const cust = await createContact(ctx, 'Acme', 'billing@acme.test');
      const inv = await createInvoice(ctx, cust, {
        number: 'A',
        issueDate: '2026-01-10',
        total: '100.00',
      });
      await post(ctx, `/api/invoices/${inv}/mark-sent`);

      const res = await ctx.app.request(`/api/contacts/${cust}/statement/send`, {
        method: 'POST',
        headers: headers(ctx),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { sentTo: string }).sentTo).toBe('billing@acme.test');
      expect(rec.sent).toHaveLength(1);
      expect(rec.sent[0]?.to).toBe('billing@acme.test');
      expect(rec.sent[0]?.subject).toContain('$100.00');
      expect(rec.sent[0]?.html).toContain('Invoice A');
    } finally {
      await close();
    }
  });

  it('honors a `to` override', async () => {
    const rec = makeRecorder();
    const { ctx, close } = await setup('send-ov@example.com', { mailer: rec.mailer });
    try {
      const cust = await createContact(ctx, 'Acme', 'billing@acme.test');
      const res = await ctx.app.request(`/api/contacts/${cust}/statement/send`, {
        method: 'POST',
        headers: headers(ctx),
        body: JSON.stringify({ to: 'ap@acme.test' }),
      });
      expect(res.status).toBe(200);
      expect(rec.sent[0]?.to).toBe('ap@acme.test');
    } finally {
      await close();
    }
  });

  it('500s when no mailer is configured', async () => {
    const { ctx, close } = await setup('send-nomail@example.com');
    try {
      const cust = await createContact(ctx);
      const res = await ctx.app.request(`/api/contacts/${cust}/statement/send`, {
        method: 'POST',
        headers: headers(ctx),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(500);
    } finally {
      await close();
    }
  });

  it('400s when the customer has no email and no override is given', async () => {
    const rec = makeRecorder();
    const { ctx, close } = await setup('send-noemail@example.com', { mailer: rec.mailer });
    try {
      const cust = await createContact(ctx, 'No Email', null);
      const res = await ctx.app.request(`/api/contacts/${cust}/statement/send`, {
        method: 'POST',
        headers: headers(ctx),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      expect(rec.sent).toHaveLength(0);
    } finally {
      await close();
    }
  });
});
